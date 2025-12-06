const http = require("http");
const { WebSocketServer } = require("ws");
const { createClient } = require("redis");
function genId() { return Math.random().toString(36).slice(2, 10); }
const { Types, encode, decode } = require("../common/messages");
const { makeLogger } = require("../common/logger");
const log = makeLogger("gateway");

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const POD_ID = process.env.POD_ID || `pod-${Math.random().toString(36).slice(2, 8)}`;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS_PER_POD || "9999", 10);

const server = http.createServer();
const wss = new WebSocketServer({ server });

const pub = createClient({ url: REDIS_URL });
const sub = createClient({ url: REDIS_URL });

const connections = new Map();
const regionSubscribers = new Map();
let idleSince = null;
let shuttingDown = false;
let currentPodPlayerCount = 0;

async function init() {
    await pub.connect();
    await sub.connect();
    await pub.sAdd("pods:active", POD_ID);
    await pub.hSet(`pod:${POD_ID}:status`, { status: "running" });
    await pub.hSet(`pod:${POD_ID}:metrics`, { playerCount: 0 });
    log.info("init done", { podId: POD_ID, port: PORT });
}

function subscribeRegion(regionId) {
    if (regionSubscribers.has(regionId)) return;
    regionSubscribers.set(regionId, true);
    sub.subscribe(`region:${regionId}:out`, async (message) => {
        const parsed = decode(message);
        if (!parsed) return;
        if (parsed.type === Types.handover) {
            const p = parsed.payload || {};
            const toRegion = p.toRegionId;
            const playerId = p.playerId;
            if (toRegion && playerId) {
                for (const [connId, info] of connections) {
                    if (info.playerId === playerId && info.ws.readyState === 1) {
                        info.regionId = toRegion;
                        try { info.ws.send(encode(Types.assign_room, { roomId: toRegion, podId: POD_ID })); } catch (e) { }
                        subscribeRegion(toRegion);
                        log.info("handover applied", { connId, playerId, toRegionId: toRegion });
                    }
                }
            }
        }
        const region = regionId;
        for (const [, info] of connections) {
            if (info.regionId === region && info.ws.readyState === 1) {
                info.ws.send(encode(parsed.type, parsed.payload));
            }
        }
        log.debug("region out broadcast", { regionId, type: parsed.type });
    });
    log.info("region subscribed", { regionId });
}

function updatePodPlayerCount() {
    let count = 0;
    for (const [, info] of connections) {
        if (info.podId === POD_ID) count += 1;
    }
    currentPodPlayerCount = count;
    if (count === 0) {
        if (idleSince == null) idleSince = Date.now();
    } else {
        idleSince = null;
    }
    return pub.hSet(`pod:${POD_ID}:metrics`, { playerCount: count });
}

wss.on("connection", async (ws, req) => {
    let current = 0;
    for (const [, info] of connections) {
        if (info.podId === POD_ID) current += 1;
    }
    if (current >= MAX_PLAYERS) {
        try {
            await new Promise((resolve) => {
                http.get(`http://matchmaker:4000/allocate`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve);
            });
        } catch (e) { }
        try { ws.send(encode(Types.busy_pod, { podId: POD_ID })); } catch (e) { }
        try { ws.close(4002); } catch (e) { }
        log.warn("pod at capacity, rejecting connection", { podId: POD_ID, current, max: MAX_PLAYERS });
        return;
    }
    const connId = genId();
    connections.set(connId, { ws, playerId: null, regionId: null, podId: POD_ID });
    updatePodPlayerCount();
    log.info("ws connected", { connId });



    ws.on("message", async (data) => {
        const msg = decode(data);
        if (!msg) return;
        if (msg.type === Types.join) {
            const playerId = msg.payload?.playerId || genId();
            const incoming = msg.payload?.roomId;
            let regionId = incoming;
            if (!regionId || !/^region-\-?\d+-\-?\d+$/.test(regionId)) {
                regionId = await allocateRegion();
            }
            const info = connections.get(connId);
            info.playerId = playerId;
            info.regionId = regionId;
            ws.send(encode(Types.assign_room, { roomId: regionId, podId: POD_ID }));
            subscribeRegion(regionId);
            await pub.sAdd(`region:${regionId}:players`, playerId);
            await pub.expire(`region:${regionId}:players`, 120);
            try {
                await pub.publish(`region:${regionId}:in`, JSON.stringify({ type: Types.start_game, playerId, podId: POD_ID }));
            } catch (e) { }
            updatePodPlayerCount();
            log.info("player joined", { connId, playerId, regionId });
        } else if (msg.type === Types.input_move) {
            const info = connections.get(connId);
            if (!info || !info.regionId) return;
            const payload = {
                playerId: info.playerId,
                regionId: info.regionId,
                podId: POD_ID,
                input: msg.payload,
                ts: Date.now(),
            };
            await pub.publish(`region:${info.regionId}:in`, JSON.stringify(payload));
            log.debug("input forwarded", { playerId: info.playerId, regionId: info.regionId });
        } else if (msg.type === Types.input_attack) {
            const info = connections.get(connId);
            if (!info || !info.regionId) return;
            const payload = {
                playerId: info.playerId,
                regionId: info.regionId,
                podId: POD_ID,
                type: Types.input_attack,
                angle: msg.payload?.angle,
                ts: Date.now(),
            };
            await pub.publish(`region:${info.regionId}:in`, JSON.stringify(payload));
            log.info("attack forwarded", { playerId: info.playerId, regionId: info.regionId });
        } else if (msg.type === Types.ping) {
            const info = connections.get(connId);
            if (!info) return;
            const tsClient = msg.payload?.ts || Date.now();
            try { ws.send(encode(Types.pong_gateway, { ts_client: tsClient, ts_gateway: Date.now() })); } catch (e) { }
            if (info.regionId) {
                const payload = { type: Types.ping_worker, regionId: info.regionId, playerId: info.playerId, ts_client: tsClient };
                await pub.publish(`region:${info.regionId}:in`, JSON.stringify(payload));
            }
        } else if (msg.type === Types.latency_report) {
            const info = connections.get(connId);
            if (!info || !info.regionId) return;
            const payload = { playerId: info.playerId, regionId: info.regionId, rtt_ms: msg.payload?.rtt_ms, ts: Date.now() };
            await pub.publish(`region:${info.regionId}:out`, JSON.stringify({ type: Types.latency_update, payload }));
            log.debug("latency_update broadcast", { regionId: info.regionId, playerId: info.playerId, rtt_ms: msg.payload?.rtt_ms });
        } else if (msg.type === Types.leave) {
            const info = connections.get(connId);
            if (info && info.regionId && info.playerId) {
                await pub.sRem(`region:${info.regionId}:players`, info.playerId);
                try {
                    await pub.publish(`region:${info.regionId}:in`, JSON.stringify({ type: Types.leave, regionId: info.regionId, playerId: info.playerId }));
                } catch (e) { }
            }
            connections.delete(connId);
            updatePodPlayerCount();
            ws.close();
            log.info("player left", { connId });
        } else if (msg.type === Types.give_buffs) {
            const info = connections.get(connId);
            if (!info || !info.regionId) return;
            const payload = {
                type: Types.give_buffs,
                playerId: info.playerId,
                regionId: info.regionId,
                size: parseInt(msg.payload?.size || 0, 10) || 0,
                ts: Date.now(),
            };
            await pub.publish(`region:${info.regionId}:in`, JSON.stringify(payload));
            log.info("give_buffs forwarded", { playerId: info.playerId, regionId: info.regionId, size: payload.size });
        }
    });

    ws.on("close", async () => {
        const info = connections.get(connId);
        if (info) {
            if (info.regionId && info.playerId) {
                await pub.sRem(`region:${info.regionId}:players`, info.playerId);
                try {
                    await pub.publish(`region:${info.regionId}:in`, JSON.stringify({ type: Types.leave, regionId: info.regionId, playerId: info.playerId }));
                } catch (e) { }
            }
            connections.delete(connId);
        }
        updatePodPlayerCount();
        log.info("ws closed", { connId });
    });
});

async function allocateRegion() {
    const id = `region-0-0`;
    return id;
}

server.listen(PORT, async () => {
    await init();
    setInterval(async () => {
        if (shuttingDown) return;
        if (currentPodPlayerCount === 0 && idleSince && (Date.now() - idleSince) >= 20000) {
            try {
                await new Promise((resolve) => {
                    http.get(`http://matchmaker:4000/scaleDown`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve);
                });
            } catch (e) { }
            try {
                await pub.sRem("pods:active", POD_ID);
                await pub.hSet(`pod:${POD_ID}:status`, { status: "terminating" });
            } catch (e) { }
            shuttingDown = true;
            log.warn("pod idle for 20s, exiting", { podId: POD_ID });
            setTimeout(() => { try { process.exit(0); } catch (e) { } }, 300);
        }
    }, 1000);
    log.info("listening", { port: PORT, podId: POD_ID });
});

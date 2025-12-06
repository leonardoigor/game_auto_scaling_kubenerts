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
const roomSubscribers = new Map();
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

function subscribeRoom(roomId) {
    if (roomSubscribers.has(roomId)) return;
    roomSubscribers.set(roomId, true);
    sub.subscribe(`room:${roomId}:out`, (message) => {
        const parsed = decode(message);
        if (!parsed) return;
        const room = roomId;
        for (const [, info] of connections) {
            if (info.roomId === room && info.ws.readyState === 1) {
                info.ws.send(encode(Types.state_update, parsed.payload));
            }
        }
        log.debug("state_update broadcast", { roomId });
    });
    log.info("room subscribed", { roomId });
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
    connections.set(connId, { ws, playerId: null, roomId: null, podId: POD_ID });
    updatePodPlayerCount();
    log.info("ws connected", { connId });



    ws.on("message", async (data) => {
        const msg = decode(data);
        if (!msg) return;
        if (msg.type === Types.join) {
            const playerId = msg.payload?.playerId || genId();
            let roomId = msg.payload?.roomId;
            if (!roomId) {
                roomId = await allocateRoom();
            }
            const info = connections.get(connId);
            info.playerId = playerId;
            info.roomId = roomId;
            ws.send(encode(Types.assign_room, { roomId, podId: POD_ID }));
            subscribeRoom(roomId);
            await pub.sAdd(`room:${roomId}:players`, playerId);
            await pub.expire(`room:${roomId}:players`, 120);
            updatePodPlayerCount();
            log.info("player joined", { connId, playerId, roomId });
        } else if (msg.type === Types.input_move) {
            const info = connections.get(connId);
            if (!info || !info.roomId) return;
            const payload = {
                playerId: info.playerId,
                roomId: info.roomId,
                podId: POD_ID,
                input: msg.payload,
                ts: Date.now(),
            };
            await pub.publish(`room:${info.roomId}:in`, JSON.stringify(payload));
            log.debug("input forwarded", { playerId: info.playerId, roomId: info.roomId });
        } else if (msg.type === Types.input_attack) {
            const info = connections.get(connId);
            if (!info || !info.roomId) return;
            const payload = {
                playerId: info.playerId,
                roomId: info.roomId,
                podId: POD_ID,
                type: Types.input_attack,
                angle: msg.payload?.angle,
                ts: Date.now(),
            };
            await pub.publish(`room:${info.roomId}:in`, JSON.stringify(payload));
            log.info("attack forwarded", { playerId: info.playerId, roomId: info.roomId });
        } else if (msg.type === Types.leave) {
            const info = connections.get(connId);
            if (info && info.roomId && info.playerId) {
                await pub.sRem(`room:${info.roomId}:players`, info.playerId);
                try {
                    await pub.publish(`room:${info.roomId}:in`, JSON.stringify({ type: Types.leave, roomId: info.roomId, playerId: info.playerId }));
                } catch (e) { }
            }
            connections.delete(connId);
            updatePodPlayerCount();
            ws.close();
            log.info("player left", { connId });
        }
    });

    ws.on("close", async () => {
        const info = connections.get(connId);
        if (info) {
            if (info.roomId && info.playerId) {
                await pub.sRem(`room:${info.roomId}:players`, info.playerId);
                try {
                    await pub.publish(`room:${info.roomId}:in`, JSON.stringify({ type: Types.leave, roomId: info.roomId, playerId: info.playerId }));
                } catch (e) { }
            }
            connections.delete(connId);
        }
        updatePodPlayerCount();
        log.info("ws closed", { connId });
    });
});

async function allocateRoom() {
    const id = `room-${Math.random().toString(36).slice(2, 6)}`;
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

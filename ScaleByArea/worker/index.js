const { createClient } = require("redis");
const { makeLogger } = require("../common/logger");
const log = makeLogger("worker");
function genId() { return Math.random().toString(36).slice(2, 10); }

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TICK_MS = parseInt(process.env.TICK_MS || "50", 10);
const CELL_W = parseInt(process.env.CELL_W || "800", 10);
const CELL_H = parseInt(process.env.CELL_H || "600", 10);
const REGION_ID = process.env.REGION_ID || "region-0-0";
const GHOST_ZONE = parseInt(process.env.GHOST_ZONE || "50", 10);
const MATCHMAKER_URL = process.env.MATCHMAKER_URL || "http://matchmaker:4000";
const COLLISION_RADIUS = 12;
const WEAPON_RANGE = 120;
const ATTACK_COOLDOWN_MS = 300;
const BUFF_PICK_RADIUS = 14;
const BUFF_DURATION_MS = 20000;
const BUFF_AURA_RANGE = 100;

let sub = createClient({ url: REDIS_URL });
let pub = createClient({ url: REDIS_URL });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function connectWithRetry(client, label) {
  for (let i = 0; i < 20; i++) {
    try { await client.connect(); log.info("redis connected", { label }); return; }
    catch (e) { log.warn("redis connect retry", { label, attempt: i + 1 }); await sleep(500 * Math.min(10, i + 1)); }
  }
  throw new Error("redis connect failed");
}

const regionState = { players: new Map(), projectiles: [], buffItems: [], lastUpdate: Date.now() };
let idleSince = null;
let shuttingDown = false;
let lastGlobalCheckTs = 0;
let lastGlobalCount = 0;
function initBuffItems() {
  const types = ['V', 'M', 'A', 'D'];
  const items = [];
  const { col, row } = parseRegionCoord(REGION_ID);
  const minX = col * CELL_W;
  const minY = row * CELL_H;
  for (let i = 0; i < 6; i++) {
    items.push({ id: genId(), x: minX + Math.random() * CELL_W, y: minY + Math.random() * CELL_H, type: types[Math.floor(Math.random() * types.length)] });
  }
  regionState.buffItems = items;
}
initBuffItems();

function parseRegionCoord(id) {
  const m = /region-(\-?\d+)-(\-?\d+)/.exec(id || "region-0-0");
  return m ? { col: parseInt(m[1], 10), row: parseInt(m[2], 10) } : { col: 0, row: 0 };
}
const { col: OWN_COL, row: OWN_ROW } = parseRegionCoord(REGION_ID);
const OWN_MIN_X = OWN_COL * CELL_W;
const OWN_MAX_X = OWN_MIN_X + CELL_W;
const OWN_MIN_Y = OWN_ROW * CELL_H;
const OWN_MAX_Y = OWN_MIN_Y + CELL_H;

function regionCoordForPos(x, y) {
  const col = Math.floor(x / CELL_W);
  const row = Math.floor(y / CELL_H);
  return { col, row };
}
function regionIdFromCoord(col, row) { return `region-${col}-${row}`; }
function neighborCoords() {
  return [
    { col: OWN_COL - 1, row: OWN_ROW },
    { col: OWN_COL + 1, row: OWN_ROW },
    { col: OWN_COL, row: OWN_ROW - 1 },
    { col: OWN_COL, row: OWN_ROW + 1 },
  ];
}

function applyInput(state, playerId, input) {
  const p = state.players.get(playerId) || { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0, buffs: [] };
  const dir = input?.dir || { x: 0, y: 0 };
  p.vx = p.speed * dir.x;
  p.vy = p.speed * dir.y;
  state.players.set(playerId, p);
}

function distPointToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - x1, py - y1);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - x2, py - y2);
  const b = c1 / c2;
  const bx = x1 + b * vx;
  const by = y1 + b * vy;
  return Math.hypot(px - bx, py - by);
}

function handleAttack(state, attackerId, angle) {
  const attacker = state.players.get(attackerId);
  if (!attacker || attacker.dead) return;
  const now = Date.now();
  if ((attacker.lastAttackTs || 0) + ATTACK_COOLDOWN_MS > now) return;
  attacker.lastAttackTs = now;
  const speed = 600;
  const px = attacker.x + Math.cos(angle) * 12;
  const py = attacker.y + Math.sin(angle) * 12;
  const proj = { x: px, y: py, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ownerId: attackerId };
  state.projectiles.push(proj);
  state.players.set(attackerId, attacker);
}

function cleanupExpiredBuffs(state) {
  const now = Date.now();
  for (const [pid, p] of state.players) {
    if (!Array.isArray(p.buffs)) p.buffs = [];
    const remain = [];
    const expired = [];
    for (const b of p.buffs) {
      if (b && typeof b.expiresAt === 'number' && b.expiresAt > now) remain.push(b);
      else if (b && b.type) expired.push(b);
    }
    p.buffs = remain;
    if (!Array.isArray(state.buffItems)) state.buffItems = [];
    for (const b of expired) {
      state.buffItems.push({ id: genId(), x: Math.random() * WORLD.width, y: Math.random() * WORLD.height, type: b.type });
    }
    state.players.set(pid, p);
  }
}

function computeMultipliers(state) {
  const ownSpeed = new Map();
  const ownAttack = new Map();
  const debuffSpeed = new Map();
  const debuffAttack = new Map();
  for (const [pid, p] of state.players) {
    ownSpeed.set(pid, 1);
    ownAttack.set(pid, 1);
    debuffSpeed.set(pid, 1);
    debuffAttack.set(pid, 1);
  }
  for (const [pid, p] of state.players) {
    const buffs = Array.isArray(p.buffs) ? p.buffs : [];
    let sMult = 1;
    let aMult = 1;
    for (const b of buffs) {
      if (!b || !b.type) continue;
      if (b.type === 'V') sMult *= 1.5;
      else if (b.type === 'A') aMult *= 1.5;
    }
    ownSpeed.set(pid, sMult);
    ownAttack.set(pid, aMult);
  }
  for (const [pid, p] of state.players) {
    const buffs = Array.isArray(p.buffs) ? p.buffs : [];
    const hasM = buffs.some((b) => b.type === 'M');
    const hasD = buffs.some((b) => b.type === 'D');
    if (!hasM && !hasD) continue;
    for (const [qid, q] of state.players) {
      if (qid === pid) continue;
      const dist = Math.hypot(q.x - p.x, q.y - p.y);
      if (dist <= BUFF_AURA_RANGE) {
        if (hasM) debuffSpeed.set(qid, (debuffSpeed.get(qid) || 1) * 0.7);
        if (hasD) debuffAttack.set(qid, (debuffAttack.get(qid) || 1) * 0.7);
      }
    }
  }
  return { ownSpeed, ownAttack, debuffSpeed, debuffAttack };
}

async function exportGhosts() {
  const ghosts = [];
  for (const [pid, p] of regionState.players) {
    if (p.dead) continue;
    const nearLeft = (p.x - OWN_MIN_X) <= GHOST_ZONE;
    const nearRight = (OWN_MAX_X - p.x) <= GHOST_ZONE;
    const nearTop = (p.y - OWN_MIN_Y) <= GHOST_ZONE;
    const nearBottom = (OWN_MAX_Y - p.y) <= GHOST_ZONE;
    if (nearLeft || nearRight || nearTop || nearBottom) {
      ghosts.push({ id: pid, x: p.x, y: p.y, podId: p.podId, speed: p.speed, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => ({ type: b.type, expiresAt: b.expiresAt })) : []) });
    }
  }
  try { await pub.set(`region:${REGION_ID}:ghosts`, JSON.stringify({ players: ghosts }), { EX: 1 }); } catch (e) { }
}

async function importNeighborGhosts() {
  const neighbors = neighborCoords().map((c) => regionIdFromCoord(c.col, c.row));
  const ghosts = [];
  for (const rid of neighbors) {
    try {
      const raw = await pub.get(`region:${rid}:ghosts`);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed?.players) ? parsed.players : [];
      ghosts.push(...arr);
    } catch (e) { }
  }
  return ghosts;
}

async function stepRegion(dt) {
  cleanupExpiredBuffs(regionState);
  const mult = computeMultipliers(regionState);
  const handovers = [];
  for (const [pid, p] of regionState.players) {
    const dirx = (p.speed !== 0) ? (p.vx / p.speed) : 0;
    const diry = (p.speed !== 0) ? (p.vy / p.speed) : 0;
    const effSpeed = p.speed * (mult.ownSpeed.get(pid) || 1) * (mult.debuffSpeed.get(pid) || 1);
    p.x += dirx * effSpeed * dt;
    p.y += diry * effSpeed * dt;
    const rc = regionCoordForPos(p.x, p.y);
    if (rc.col !== OWN_COL || rc.row !== OWN_ROW) {
      const toRegionId = regionIdFromCoord(rc.col, rc.row);
      const exists = await regionExists(toRegionId);
      if (!exists) {
        const creating = await isRegionCreating(toRegionId);
        if (!creating) {
          try { await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "region_creating", payload: { toRegionId } })); } catch (e) { }
          await markRegionCreating(toRegionId);
          try {
            await new Promise((resolve) => {
              require("http").get(`${MATCHMAKER_URL}/spawnWorker?regionId=${toRegionId}`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve);
            });
          } catch (e) { }
        }
        if (p.x < OWN_MIN_X) p.x = OWN_MIN_X;
        if (p.y < OWN_MIN_Y) p.y = OWN_MIN_Y;
        if (p.x > OWN_MAX_X) p.x = OWN_MAX_X;
        if (p.y > OWN_MAX_Y) p.y = OWN_MAX_Y;
        regionState.players.set(pid, p);
        continue;
      }
      const wasCreating = await isRegionCreating(toRegionId);
      if (wasCreating) {
        await clearRegionCreating(toRegionId);
        try { await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "region_created", payload: { toRegionId } })); } catch (e) { }
      }
      handovers.push({ playerId: pid, toRegionId, snapshot: { id: pid, x: p.x, y: p.y, podId: p.podId, speed: p.speed, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => ({ type: b.type, expiresAt: b.expiresAt })) : []) } });
    } else {
      regionState.players.set(pid, p);
    }
  }
  for (const h of handovers) {
    regionState.players.delete(h.playerId);
    try { await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "handover", payload: { playerId: h.playerId, fromRegionId: REGION_ID, toRegionId: h.toRegionId } })); } catch (e) { }
    try { await pub.publish(`region:${h.toRegionId}:in`, JSON.stringify({ type: "handover_join", playerId: h.playerId, snapshot: h.snapshot })); } catch (e) { }
  }
  const remainingItems = [];
  for (const item of (regionState.buffItems || [])) {
    let picked = false;
    for (const [pid, p] of regionState.players) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - item.x, p.y - item.y);
      if (d <= BUFF_PICK_RADIUS) {
        if (!Array.isArray(p.buffs)) p.buffs = [];
        p.buffs.push({ type: item.type, expiresAt: Date.now() + BUFF_DURATION_MS });
        regionState.players.set(pid, p);
        picked = true;
        break;
      }
    }
    if (!picked) remainingItems.push(item);
  }
  regionState.buffItems = remainingItems;
  const nextProjectiles = [];
  for (const b of regionState.projectiles) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    let remove = false;
    if (b.x < OWN_MIN_X || b.y < OWN_MIN_Y || b.x > OWN_MAX_X || b.y > OWN_MAX_Y) remove = true;
    if (!remove) {
      for (const [pid, p] of regionState.players) {
        if (pid === b.ownerId) continue;
        if (p.dead) continue;
        const d = Math.hypot(p.x - b.x, p.y - b.y);
        if (d <= COLLISION_RADIUS) {
          const base = Math.floor(0.2 * (p.maxHp || 100));
          const attUp = mult.ownAttack.get(b.ownerId) || 1;
          const attDown = mult.debuffAttack.get(b.ownerId) || 1;
          const damage = Math.max(1, Math.floor(base * attUp * attDown));
          p.hp = Math.max(0, (p.hp ?? p.maxHp ?? 100) - damage);
          if (p.hp <= 0 && !p.dead) { p.dead = true; p.killerId = b.ownerId; }
          regionState.players.set(pid, p);
          remove = true;
          break;
        }
      }
    }
    if (!remove) nextProjectiles.push(b);
  }
  regionState.projectiles = nextProjectiles;
  regionState.lastUpdate = Date.now();
  await setAlive();
  await exportGhosts();
  const neighborGhosts = await importNeighborGhosts();
  const payload = { regionId: REGION_ID, players: Array.from(regionState.players.entries()).map(([id, p]) => ({ id, x: p.x, y: p.y, podId: p.podId, speed: p.speed, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => ({ type: b.type, expiresAt: b.expiresAt })) : []) })), projectiles: regionState.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (regionState.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })), ghostPlayers: neighborGhosts, zones: buildZones() };
  return pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "state_update", payload }));
}

function buildZones() {
  const zones = [];
  const x = OWN_MIN_X;
  const y = OWN_MIN_Y;
  const w = CELL_W;
  const h = CELL_H;
  zones.push({ regionId: REGION_ID, x, y, w, h, ghost: { x: x + GHOST_ZONE, y: y + GHOST_ZONE, w: w - 2 * GHOST_ZONE, h: h - 2 * GHOST_ZONE } });
  return zones;
}

async function persistRegion() {
  const state = { players: Array.from(regionState.players.entries()).map(([id, p]) => ({ id, x: p.x, y: p.y, speed: p.speed, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => ({ type: b.type, expiresAt: b.expiresAt })) : []) })), projectiles: regionState.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (regionState.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })) };
  await pub.set(`region:${REGION_ID}:state`, JSON.stringify(state), { EX: 120 });
}

async function tick() {
  const dt = TICK_MS / 1000;
  await stepRegion(dt);
  await persistRegion();
  const pc = regionState.players.size;
  try {
    const now = Date.now();
    if ((now - lastGlobalCheckTs) >= 1000) {
      const n = await pub.sendCommand(['SCARD', `region:${REGION_ID}:players`]);
      lastGlobalCount = parseInt(n || '0', 10) || 0;
      lastGlobalCheckTs = now;
    }
  } catch (e) { }
  const anyPlayers = (pc > 0) || (lastGlobalCount > 0);
  if (anyPlayers) idleSince = null;
  else { if (idleSince == null) idleSince = Date.now(); }
  if (!shuttingDown && idleSince && (Date.now() - idleSince) >= 20000) {
    shuttingDown = true;
    try { await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "region_dying", payload: { regionId: REGION_ID } })); } catch (e) { }
    try {
      await new Promise((resolve) => {
        require("http").get(`${MATCHMAKER_URL}/killWorker?regionId=${REGION_ID}`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve);
      });
    } catch (e) { }
    setTimeout(() => { try { process.exit(0); } catch (e) { } }, 500);
  }
  log.debug("tick", { region: REGION_ID, players: pc });
}

async function main() {
  const list = (process.env.REDIS_URLS || `${REDIS_URL},redis://redis:6379,redis://localhost:6379,redis://host.docker.internal:6379`).split(",").map(s => s.trim()).filter(Boolean);
  let connected = false;
  for (const u of list) {
    try {
      sub = createClient({ url: u });
      pub = createClient({ url: u });
      await connectWithRetry(sub, "sub");
      await connectWithRetry(pub, "pub");
      log.info("redis connected", { url: u });
      connected = true;
      break;
    } catch (e) {
      try { await sub.disconnect(); } catch (e2) { }
      try { await pub.disconnect(); } catch (e3) { }
    }
  }
  if (!connected) throw new Error("redis connect failed for all urls");
  await sub.subscribe(`region:${REGION_ID}:in`, async (raw) => {
    try {
      const msg = JSON.parse(raw);
      const playerId = msg.playerId || genId();
      if (msg.type === "leave") {
        regionState.players.delete(playerId);
        log.info("leave", { regionId: REGION_ID, playerId });
      } else if (msg.type === "input_attack") {
        if (!regionState.players.has(playerId)) regionState.players.set(playerId, { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0 });
        handleAttack(regionState, playerId, msg.angle || 0);
        const payload = { regionId: REGION_ID, players: Array.from(regionState.players.entries()).map(([id, p]) => ({ id, x: p.x, y: p.y, podId: p.podId, speed: p.speed, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => ({ type: b.type, expiresAt: b.expiresAt })) : []) })), projectiles: regionState.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (regionState.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })), zones: buildZones() };
        await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "state_update", payload }));
        log.info("attack", { regionId: REGION_ID, playerId });
      } else if (msg.type === "start_game") {
        if (!regionState.players.has(playerId)) {
          regionState.players.set(playerId, { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: msg.podId || null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0, buffs: [] });
          const payload = { regionId: REGION_ID, players: Array.from(regionState.players.entries()).map(([id, p]) => ({ id, x: p.x, y: p.y, podId: p.podId, speed: p.speed, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => ({ type: b.type, expiresAt: b.expiresAt })) : []) })), projectiles: regionState.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (regionState.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })), zones: buildZones() };
          await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "state_update", payload }));
          log.info("start_game", { regionId: REGION_ID, playerId });
        }
      } else if (msg.type === "handover_join") {
        const snap = msg.snapshot;
        if (snap && snap.id) {
          regionState.players.set(snap.id, { x: snap.x, y: snap.y, vx: 0, vy: 0, speed: snap.speed || 180, podId: snap.podId || null, hp: snap.hp ?? 100, maxHp: snap.maxHp ?? 100, dead: !!snap.dead, killerId: snap.killerId || null, lastAttackTs: 0, buffs: Array.isArray(snap.buffs) ? snap.buffs : [] });
          log.info("handover_join", { regionId: REGION_ID, playerId: snap.id });
        }
      } else if (msg.type === "ping_worker") {
        if (!regionState.players.has(playerId)) {
          regionState.players.set(playerId, { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: msg.podId || null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0, buffs: [] });
        }
        const tsClient = msg.ts_client || Date.now();
        const payload = { regionId: REGION_ID, playerId, ts_client: tsClient, ts_worker: Date.now() };
        await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "pong_worker", payload }));
        log.debug("pong_worker", { regionId: REGION_ID, playerId });
      } else if (msg.type === "give_buffs") {
        const size = Math.max(0, parseInt(msg.size || 0, 10) || 0);
        if (!regionState.players.has(playerId)) {
          regionState.players.set(playerId, { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: msg.podId || null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0, buffs: [] });
        }
        const p = regionState.players.get(playerId);
        if (!Array.isArray(p.buffs)) p.buffs = [];
        const types = ['V', 'A', 'M', 'D'];
        for (let i = 0; i < size; i++) {
          const t = types[Math.floor(Math.random() * types.length)];
          p.buffs.push({ type: t, expiresAt: Date.now() + BUFF_DURATION_MS });
        }
        regionState.players.set(playerId, p);
        const payload = { regionId: REGION_ID, players: Array.from(regionState.players.entries()).map(([id, p2]) => ({ id, x: p2.x, y: p2.y, podId: p2.podId, speed: p2.speed, hp: p2.hp ?? 100, maxHp: p2.maxHp ?? 100, dead: !!p2.dead, killerId: p2.killerId || null, buffs: (Array.isArray(p2.buffs) ? p2.buffs.map((b) => ({ type: b.type, expiresAt: b.expiresAt })) : []) })), projectiles: regionState.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (regionState.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })), zones: buildZones() };
        await pub.publish(`region:${REGION_ID}:out`, JSON.stringify({ type: "state_update", payload }));
        log.info("give_buffs", { regionId: REGION_ID, playerId, size });
      } else {
        if (!regionState.players.has(playerId)) regionState.players.set(playerId, { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0 });
        const existing = regionState.players.get(playerId);
        if (typeof msg.podId === "string") existing.podId = msg.podId;
        regionState.players.set(playerId, existing);
        applyInput(regionState, playerId, msg.input);
        log.debug("input", { regionId: REGION_ID, playerId });
      }
    } catch (e) { }
  });
  setInterval(() => { tick().catch((e) => { try { log.error("tick failed", { error: String(e && e.message || e) }); } catch (e2) { } }); }, TICK_MS);
  log.info("running", { tickMs: TICK_MS });
}

main();
process.on("uncaughtException", (err) => { try { log.error("uncaughtException", { error: String(err && err.message || err) }); } catch (e) { } });
process.on("unhandledRejection", (reason) => { try { log.error("unhandledRejection", { error: String(reason && reason.message || reason) }); } catch (e) { } });
async function setAlive() {
  try { await pub.set(`region:${REGION_ID}:alive`, "1", { EX: 2 }); } catch (e) { }
}

async function regionExists(rid) {
  try {
    const alive = await pub.get(`region:${rid}:alive`);
    if (alive) return true;
    const snap = await pub.get(`region:${rid}:state`);
    return !!snap;
  } catch (e) { return false; }
}

async function isRegionCreating(rid) {
  try { const v = await pub.get(`region:${rid}:creating`); return !!v; } catch (e) { return false; }
}

async function markRegionCreating(rid) {
  try { await pub.set(`region:${rid}:creating`, "1", { EX: 15 }); } catch (e) { }
}

async function clearRegionCreating(rid) {
  try { await pub.del(`region:${rid}:creating`); } catch (e) { }
}

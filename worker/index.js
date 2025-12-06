const { createClient } = require("redis");
const { makeLogger } = require("../common/logger");
const log = makeLogger("worker");
function genId() { return Math.random().toString(36).slice(2, 10); }

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TICK_MS = parseInt(process.env.TICK_MS || "50", 10);
const WORLD = { width: 800, height: 600 };
const COLLISION_RADIUS = 12;
const WEAPON_RANGE = 120;
const ATTACK_COOLDOWN_MS = 300;
const BUFF_PICK_RADIUS = 14;
const BUFF_DURATION_MS = 20000;
const BUFF_AURA_RANGE = 100;

const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function connectWithRetry(client, label) {
  for (let i = 0; i < 20; i++) {
    try { await client.connect(); log.info("redis connected", { label }); return; }
    catch (e) { log.warn("redis connect retry", { label, attempt: i + 1 }); await sleep(500 * Math.min(10, i + 1)); }
  }
  throw new Error("redis connect failed");
}

const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) {
    const types = ['V', 'M', 'A', 'D'];
    const items = [];
    for (let i = 0; i < 6; i++) {
      items.push({ id: genId(), x: Math.random() * WORLD.width, y: Math.random() * WORLD.height, type: types[Math.floor(Math.random() * types.length)] });
    }
    rooms.set(id, { players: new Map(), projectiles: [], buffItems: items, lastUpdate: Date.now() });
  }
  return rooms.get(id);
}

function applyInput(room, playerId, input) {
  const p = room.players.get(playerId) || { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0, buffs: [] };
  const dir = input?.dir || { x: 0, y: 0 };
  p.vx = p.speed * dir.x;
  p.vy = p.speed * dir.y;
  room.players.set(playerId, p);
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

function handleAttack(room, attackerId, angle) {
  const attacker = room.players.get(attackerId);
  if (!attacker || attacker.dead) return;
  const now = Date.now();
  if ((attacker.lastAttackTs || 0) + ATTACK_COOLDOWN_MS > now) return;
  attacker.lastAttackTs = now;
  const speed = 600;
  const px = attacker.x + Math.cos(angle) * 12;
  const py = attacker.y + Math.sin(angle) * 12;
  const proj = { x: px, y: py, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ownerId: attackerId };
  room.projectiles.push(proj);
  room.players.set(attackerId, attacker);
}

function cleanupExpiredBuffs(room) {
  const now = Date.now();
  for (const [pid, p] of room.players) {
    if (!Array.isArray(p.buffs)) p.buffs = [];
    const remain = [];
    const expired = [];
    for (const b of p.buffs) {
      if (b && typeof b.expiresAt === 'number' && b.expiresAt > now) remain.push(b);
      else if (b && b.type) expired.push(b);
    }
    p.buffs = remain;
    if (!Array.isArray(room.buffItems)) room.buffItems = [];
    for (const b of expired) {
      room.buffItems.push({ id: genId(), x: Math.random() * WORLD.width, y: Math.random() * WORLD.height, type: b.type });
    }
    room.players.set(pid, p);
  }
}

function computeMultipliers(room) {
  const ownSpeed = new Map();
  const ownAttack = new Map();
  const debuffSpeed = new Map();
  const debuffAttack = new Map();
  for (const [pid, p] of room.players) {
    ownSpeed.set(pid, 1);
    ownAttack.set(pid, 1);
    debuffSpeed.set(pid, 1);
    debuffAttack.set(pid, 1);
  }
  for (const [pid, p] of room.players) {
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
  for (const [pid, p] of room.players) {
    const buffs = Array.isArray(p.buffs) ? p.buffs : [];
    const hasM = buffs.some((b) => b.type === 'M');
    const hasD = buffs.some((b) => b.type === 'D');
    if (!hasM && !hasD) continue;
    for (const [qid, q] of room.players) {
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

function stepRoom(roomId, dt) {
  const room = getRoom(roomId);
  cleanupExpiredBuffs(room);
  const mult = computeMultipliers(room);
  for (const [pid, p] of room.players) {
    const dirx = (p.speed !== 0) ? (p.vx / p.speed) : 0;
    const diry = (p.speed !== 0) ? (p.vy / p.speed) : 0;
    const effSpeed = p.speed * (mult.ownSpeed.get(pid) || 1) * (mult.debuffSpeed.get(pid) || 1);
    p.x += dirx * effSpeed * dt;
    p.y += diry * effSpeed * dt;
    if (p.x < 0) p.x = 0;
    if (p.y < 0) p.y = 0;
    if (p.x > WORLD.width) p.x = WORLD.width;
    if (p.y > WORLD.height) p.y = WORLD.height;
    room.players.set(pid, p);
  }
  const remainingItems = [];
  for (const item of (room.buffItems || [])) {
    let picked = false;
    for (const [pid, p] of room.players) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - item.x, p.y - item.y);
      if (d <= BUFF_PICK_RADIUS) {
        if (!Array.isArray(p.buffs)) p.buffs = [];
        p.buffs.push({ type: item.type, expiresAt: Date.now() + BUFF_DURATION_MS });
        room.players.set(pid, p);
        picked = true;
        break;
      }
    }
    if (!picked) remainingItems.push(item);
  }
  room.buffItems = remainingItems;
  const nextProjectiles = [];
  for (const b of room.projectiles) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    let remove = false;
    if (b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) remove = true;
    if (!remove) {
      for (const [pid, p] of room.players) {
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
          room.players.set(pid, p);
          remove = true;
          break;
        }
      }
    }
    if (!remove) nextProjectiles.push(b);
  }
  room.projectiles = nextProjectiles;
  room.lastUpdate = Date.now();
  const payload = { roomId, players: Array.from(room.players.entries()).map(([id, p]) => ({ id, x: p.x, y: p.y, podId: p.podId, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => b.type) : []) })), projectiles: room.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (room.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })) };
  return pub.publish(`room:${roomId}:out`, JSON.stringify({ type: "state_update", payload }));
}

async function persistRoom(roomId) {
  const room = getRoom(roomId);
  const state = { players: Array.from(room.players.entries()).map(([id, p]) => ({ id, x: p.x, y: p.y, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => b.type) : []) })), projectiles: room.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (room.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })) };
  await pub.set(`room:${roomId}:state`, JSON.stringify(state), { EX: 120 });
}

async function tick() {
  const now = Date.now();
  const dt = TICK_MS / 1000;
  for (const roomId of rooms.keys()) {
    await stepRoom(roomId, dt);
    await persistRoom(roomId);
  }
  log.debug("tick", { rooms: rooms.size });
}

async function main() {
  await connectWithRetry(sub, "sub");
  await connectWithRetry(pub, "pub");
  await sub.pSubscribe("room:*:in", async (raw, channel) => {
    try {
      const msg = JSON.parse(raw);
      const roomId = msg.roomId;
      const playerId = msg.playerId || genId();
      const room = getRoom(roomId);
      if (msg.type === "leave") {
        room.players.delete(playerId);
        log.info("leave", { roomId, playerId });
      } else if (msg.type === "input_attack") {
        if (!room.players.has(playerId)) room.players.set(playerId, { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0 });
        handleAttack(room, playerId, msg.angle || 0);
        const payload = { roomId, players: Array.from(room.players.entries()).map(([id, p]) => ({ id, x: p.x, y: p.y, podId: p.podId, hp: p.hp ?? 100, maxHp: p.maxHp ?? 100, dead: !!p.dead, killerId: p.killerId || null, buffs: (Array.isArray(p.buffs) ? p.buffs.map((b) => b.type) : []) })), projectiles: room.projectiles.map((b) => ({ x: b.x, y: b.y })), buffItems: (room.buffItems || []).map((it) => ({ x: it.x, y: it.y, type: it.type })) };
        await pub.publish(`room:${roomId}:out`, JSON.stringify({ type: "state_update", payload }));
        log.info("attack", { roomId, playerId });
      } else {
        if (!room.players.has(playerId)) room.players.set(playerId, { x: 100, y: 100, vx: 0, vy: 0, speed: 180, podId: null, hp: 100, maxHp: 100, dead: false, killerId: null, lastAttackTs: 0 });
        const existing = room.players.get(playerId);
        if (typeof msg.podId === "string") existing.podId = msg.podId;
        room.players.set(playerId, existing);
        applyInput(room, playerId, msg.input);
        log.debug("input", { roomId, playerId });
      }
    } catch (e) { }
  });
  setInterval(tick, TICK_MS);
  log.info("running", { tickMs: TICK_MS });
}

main();

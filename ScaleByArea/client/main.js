const wsUrl = `ws://${location.hostname}:30080`;
let ws = null;
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const storedPid = sessionStorage.getItem("playerId");
const playerId = storedPid || (Math.random().toString(36).slice(2, 8));
if (!storedPid) sessionStorage.setItem("playerId", playerId);
let roomId = null;
let players = new Map();
let isLoading = false;
let mouse = { x: 0, y: 0 };
let deathShown = false;
let deathOverlay = null;
let projectiles = [];
let lastTime = 0;
let buffItems = [];
let cam = { x: 0, y: 0 };
let myRegionId = null;
let creatingRegionId = null;
let zones = [];
let pingGatewayMs = null;
let pingWorkerMs = null;
let lastPingTs = 0;
const latencyByPlayer = new Map();

function lerp(a, b, t) { return a + (b - a) * t; }

async function connect() {
  isLoading = true;
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get("room");
  let allocRoom = null;
  if (!urlRoom) {
    try {
      const resp = await fetch(`http://${location.hostname}:31400/allocate`);
      const alloc = await resp.json();
      allocRoom = alloc?.roomId || null;
    } catch (e) { }
  }

  startPing();
  roomId = urlRoom || allocRoom || `room-${Math.random().toString(36).slice(2, 6)}`;
  sessionStorage.setItem("roomId", roomId);
  const socket = new WebSocket(wsUrl);
  ws = socket;
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", payload: { playerId, roomId } }));
    sendInput();
  });
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", () => {
    if (!reconnecting) {
      reconnecting = true;
      const d = Math.min(retryDelay, 2000);
      setTimeout(() => { reconnecting = false; connect(); }, d);
      retryDelay = Math.min(retryDelay * 2, 2000);
    }
  });
}

function onMessage(ev) {
  // console.log(ev);

  const msg = JSON.parse(ev.data);
  if (msg.type === "assign_room") {
    roomId = msg.payload.roomId;
    myRegionId = roomId;
    if (creatingRegionId === roomId) creatingRegionId = null;
    sessionStorage.setItem("roomId", roomId);
    isLoading = false;
  } else if (msg.type === "busy_pod") {
    try { ev.target && ev.target.close(); } catch (e) { }
    if (!reconnecting) {
      reconnecting = true;
      const d = Math.min(retryDelay, 2000);
      setTimeout(() => { reconnecting = false; connect(); }, d);
      retryDelay = Math.min(retryDelay * 2, 2000);
    }
    isLoading = true;
  } else if (msg.type === "state_update") {
    const next = new Map();
    for (const p of msg.payload.players) {
      const prev = players.get(p.id) || { x: p.x, y: p.y, podId: p.podId, speed: p.speed, hp: p.hp, maxHp: p.maxHp, dead: p.dead, killerId: p.killerId, buffs: p.buffs };
      const nx = lerp(prev.x, p.x, 0.3);
      const ny = lerp(prev.y, p.y, 0.3);
      next.set(p.id, { x: nx, y: ny, podId: p.podId, speed: p.speed, hp: p.hp, maxHp: p.maxHp, dead: p.dead, killerId: p.killerId, buffs: p.buffs || [] });
    }
    const ghosts = Array.isArray(msg.payload.ghostPlayers) ? msg.payload.ghostPlayers : [];
    for (const g of ghosts) {
      const id = `ghost:${g.id}`;
      const prev = players.get(id) || { x: g.x, y: g.y, podId: g.podId, speed: g.speed, hp: g.hp, maxHp: g.maxHp, dead: g.dead, killerId: g.killerId, buffs: g.buffs };
      const nx = lerp(prev.x, g.x, 0.3);
      const ny = lerp(prev.y, g.y, 0.3);
      next.set(id, { x: nx, y: ny, podId: g.podId, speed: g.speed, hp: g.hp, maxHp: g.maxHp, dead: g.dead, killerId: g.killerId, buffs: g.buffs || [] });
    }
    players = next;
    projectiles = Array.isArray(msg.payload.projectiles) ? msg.payload.projectiles : [];
    buffItems = Array.isArray(msg.payload.buffItems) ? msg.payload.buffItems : [];
    zones = Array.isArray(msg.payload.zones) ? msg.payload.zones : zones;
    isLoading = false;
    const meCam = players.get(playerId);
    if (meCam) {
      cam.x = meCam.x - canvas.width / 2;
      cam.y = meCam.y - canvas.height / 2;
    }
    draw();
    updateSidebar();
    const me = players.get(playerId);
    if (me && me.dead && !deathShown) {
      showDeath(me.killerId);
    }
  }
  else if (msg.type === "region_creating") {
    creatingRegionId = msg.payload?.toRegionId || null;
  }
  else if (msg.type === "region_created") {
    const rid = msg.payload?.toRegionId || null;
    if (creatingRegionId === rid) creatingRegionId = null;
  }
  else if (msg.type === "pong_gateway") {
    const t0 = msg.payload?.ts_client;
    if (typeof t0 === "number") pingGatewayMs = Date.now() - t0;
  }
  else if (msg.type === "pong_worker") {
    const t0 = msg.payload?.ts_client;
    if (typeof t0 === "number") pingWorkerMs = Date.now() - t0;
    latencyByPlayer.set(playerId, pingWorkerMs);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "latency_report", payload: { rtt_ms: pingWorkerMs } }));
    }
  }
  else if (msg.type === "latency_update") {
    const p = msg.payload;
    if (p && p.playerId) latencyByPlayer.set(p.playerId, p.rtt_ms);
  }
}

const keys = new Set();
window.addEventListener("keydown", (e) => { keys.add(e.key); sendInput(); });
window.addEventListener("keyup", (e) => { keys.delete(e.key); sendInput(); });

function sendInput() {
  const dir = { x: 0, y: 0 };
  if (keys.has("ArrowLeft")) dir.x -= 1;
  if (keys.has("ArrowRight")) dir.x += 1;
  if (keys.has("ArrowUp")) dir.y -= 1;
  if (keys.has("ArrowDown")) dir.y += 1;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "input_move", payload: { dir } }));
  }
}

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
});

canvas.addEventListener("mousedown", () => {
  const me = players.get(playerId);
  if (!me || !ws || ws.readyState !== 1) return;
  const worldMouseX = mouse.x + cam.x;
  const worldMouseY = mouse.y + cam.y;
  const angle = Math.atan2(worldMouseY - me.y, worldMouseX - me.x);
  ws.send(JSON.stringify({ type: "input_attack", payload: { angle } }));
});

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawZones();
  if (isLoading) {
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "16px sans-serif";
    ctx.fillText("Aguardando pod disponível...", 20, 30);
  }
  for (const [id, p] of players) {
    const isGhost = id.startsWith("ghost:");
    ctx.fillStyle = id === playerId ? "#4caf50" : (isGhost ? "#888" : "#2196f3");
    ctx.fillRect((p.x - cam.x) - 10, (p.y - cam.y) - 10, 20, 20);
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    const label = `${p.podId || "pod"}:${isGhost ? id.slice(6) : id}`;
    ctx.fillText(label, (p.x - cam.x) - 10, (p.y - cam.y) - 16);
    const rtt = latencyByPlayer.get(id);
    if (typeof rtt === "number") {
      ctx.fillText(`${Math.floor(rtt)} ms`, (p.x - cam.x) - 10, (p.y - cam.y) - 28);
    }

    if (!isGhost && typeof p.hp === "number" && typeof p.maxHp === "number") {
      const w = 26;
      const h = 4;
      const pct = Math.max(0, Math.min(1, p.hp / p.maxHp));
      ctx.fillStyle = "#700";
      ctx.fillRect((p.x - cam.x) - w / 2, (p.y - cam.y) - 18, w, h);
      ctx.fillStyle = "#0f0";
      ctx.fillRect((p.x - cam.x) - w / 2, (p.y - cam.y) - 18, Math.floor(w * pct), h);
      if (Array.isArray(p.buffs) && p.buffs.length > 0) {
        ctx.fillStyle = "#fff";
        ctx.font = "12px sans-serif";
        const text = (Array.isArray(p.buffs) ? p.buffs.map((b) => b.type).join("") : "");
        ctx.fillText(text, (p.x - cam.x) - w / 2, (p.y - cam.y) - 24);
      }
    }
  }

  for (const it of (buffItems || [])) {
    ctx.fillStyle = "#ffa500";
    ctx.beginPath();
    ctx.arc(it.x - cam.x, it.y - cam.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "10px sans-serif";
    ctx.fillText(it.type, (it.x - cam.x) - 3, (it.y - cam.y) - 8);
  }

  const me = players.get(playerId);
  if (me && !me.dead) {
    const worldMouseX = mouse.x + cam.x;
    const worldMouseY = mouse.y + cam.y;
    const angle = Math.atan2(worldMouseY - me.y, worldMouseX - me.x);
    ctx.save();
    ctx.translate(me.x - cam.x, me.y - cam.y);
    ctx.rotate(angle);
    ctx.fillStyle = "#ddd";
    ctx.fillRect(10, -3, 30, 6);
    ctx.restore();
  }

  for (const b of projectiles) {
    ctx.fillStyle = "#f00";
    ctx.beginPath();
    ctx.arc(b.x - cam.x, b.y - cam.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  drawMinimap();
}

function seedColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const r = 100 + (h & 0xff) % 156;
  const g = 100 + ((h >> 8) & 0xff) % 156;
  const b = 100 + ((h >> 16) & 0xff) % 156;
  return `rgb(${r},${g},${b})`;
}

function drawZones() {
  for (const z of zones) {
    const isCreating = creatingRegionId && z.regionId === creatingRegionId;
    ctx.strokeStyle = isCreating ? "#f00" : seedColor(z.regionId);
    ctx.lineWidth = isCreating ? 3 : 2;
    ctx.strokeRect(z.x - cam.x, z.y - cam.y, z.w, z.h);
    if (!isCreating && myRegionId === z.regionId && z.ghost) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(z.ghost.x - cam.x, z.ghost.y - cam.y, z.ghost.w, z.ghost.h);
    }
  }
  if (creatingRegionId) {
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "16px sans-serif";
    ctx.fillText(`Zona ${creatingRegionId} está sendo criada...`, 20, 24);
  }
}

function drawMinimap() {
  const w = 150, h = 150, pad = 10;
  const x0 = canvas.width - w - pad, y0 = pad;
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = "#222";
  ctx.fillRect(x0, y0, w, h);
  ctx.globalAlpha = 1.0;
  const me = players.get(playerId);
  const my = zones.find((z) => z.regionId === myRegionId);
  if (my && me) {
    const scaleX = w / my.w;
    const scaleY = h / my.h;
    for (const z of zones) {
      const isCreating = creatingRegionId && z.regionId === creatingRegionId;
      ctx.strokeStyle = isCreating ? "#f00" : seedColor(z.regionId);
      ctx.lineWidth = isCreating ? 2 : 1;
      const zx = x0 + (z.x - my.x) * scaleX;
      const zy = y0 + (z.y - my.y) * scaleY;
      ctx.strokeRect(zx, zy, z.w * scaleX, z.h * scaleY);
    }
    for (const it of (buffItems || [])) {
      if (it.x < my.x || it.x > (my.x + my.w) || it.y < my.y || it.y > (my.y + my.h)) continue;
      const ix = x0 + (it.x - my.x) * scaleX;
      const iy = y0 + (it.y - my.y) * scaleY;
      ctx.fillStyle = "#ffa500";
      ctx.beginPath();
      ctx.arc(ix, iy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    let nearest = null;
    let nearestDist = Infinity;
    for (const [id, p] of players) {
      if (id === playerId) continue;
      const isGhost = id.startsWith("ghost:");
      const dx = (p.x || 0) - (me.x || 0);
      const dy = (p.y || 0) - (me.y || 0);
      const d = Math.hypot(dx, dy);
      if (d < nearestDist && (!isGhost || nearest == null)) { nearest = { id, p, dx, dy, d }; nearestDist = d; }
      const inside = (p.x >= my.x && p.x <= (my.x + my.w) && p.y >= my.y && p.y <= (my.y + my.h));
      if (inside) {
        const px2 = x0 + (p.x - my.x) * scaleX;
        const py2 = y0 + (p.y - my.y) * scaleY;
        ctx.fillStyle = isGhost ? "#888" : "#1e88e5";
        ctx.fillRect(px2 - 1, py2 - 1, 3, 3);
      }
    }
    ctx.fillStyle = "#0f0";
    ctx.beginPath();
    const px = x0 + (me.x - my.x) * scaleX;
    const py = y0 + (me.y - my.y) * scaleY;
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
    if (nearest && !(nearest.p.x >= my.x && nearest.p.x <= (my.x + my.w) && nearest.p.y >= my.y && nearest.p.y <= (my.y + my.h))) {
      const ang = Math.atan2(nearest.dy, nearest.dx);
      const ep = edgePointForAngle(px, py, x0, y0, w, h, ang);
      ctx.strokeStyle = "#ffeb3b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(ep.x, ep.y);
      ctx.stroke();
      ctx.save();
      ctx.translate(ep.x, ep.y);
      ctx.rotate(ang);
      ctx.fillStyle = "#ffeb3b";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-6, -3);
      ctx.lineTo(-6, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

function edgePointForAngle(cx, cy, x0, y0, w, h, ang) {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (x0 + w - cx) / dx);
  if (dx < 0) t = Math.min(t, (x0 - cx) / dx);
  if (dy > 0) t = Math.min(t, (y0 + h - cy) / dy);
  if (dy < 0) t = Math.min(t, (y0 - cy) / dy);
  const ex = cx + dx * t;
  const ey = cy + dy * t;
  return { x: Math.max(x0, Math.min(x0 + w, ex)), y: Math.max(y0, Math.min(y0 + h, ey)) };
}

function showDeath(killerId) {
  deathShown = true;
  const who = killerId || "desconhecido";
  if (!deathOverlay) {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.right = "0";
    overlay.style.bottom = "0";
    overlay.style.background = "rgba(0,0,0,0.6)";
    overlay.style.display = "flex";
    overlay.style.flexDirection = "column";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    const msg = document.createElement("div");
    msg.style.color = "#fff";
    msg.style.font = "20px sans-serif";
    msg.textContent = `Você morreu para ${who}`;
    const btn = document.createElement("button");
    btn.textContent = "Tentar de novo";
    btn.style.marginTop = "12px";
    btn.style.padding = "8px 12px";
    btn.onclick = () => { location.reload(); };
    overlay.appendChild(msg);
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
    deathOverlay = overlay;
  }
}

function loop() {
  draw();
  updateSidebar();
  requestAnimationFrame(loop);
}

function computeEffectiveStats() {
  const me = players.get(playerId);
  if (!me) return { baseSpeed: 0, effSpeed: 0, hp: 0, buffs: [] };
  const baseSpeed = typeof me.speed === "number" ? me.speed : 180;
  let ownSpeed = 1;
  let enemySpeedDebuff = 1;
  for (const b of (me.buffs || [])) {
    if (b.type === "V") ownSpeed *= 1.5;
  }
  const myZone = zones.find((z) => z.regionId === myRegionId);
  const meInGhost = !!(myZone && myZone.ghost && me && me.x >= myZone.ghost.x && me.x <= (myZone.ghost.x + myZone.ghost.w) && me.y >= myZone.ghost.y && me.y <= (myZone.ghost.y + myZone.ghost.h));
  for (const [id, p] of players) {
    if (id === playerId) continue;
    const isGhost = id.startsWith("ghost:");
    if (isGhost && !meInGhost) continue;
    const hasM = Array.isArray(p.buffs) && p.buffs.some((bb) => bb.type === "M");
    if (!hasM) continue;
    const dist = Math.hypot((p.x || 0) - (me.x || 0), (p.y || 0) - (me.y || 0));
    if (dist <= 100) enemySpeedDebuff *= 0.7;
  }
  const effSpeed = Math.floor(baseSpeed * ownSpeed * enemySpeedDebuff);
  return { baseSpeed, effSpeed, hp: me.hp || 0, buffs: me.buffs || [] };
}

function updateSidebar() {
  const box = document.getElementById("sidebar-info");
  if (!box) return;
  const me = players.get(playerId);
  const stats = computeEffectiveStats();
  const buffsList = (stats.buffs || []).map((b) => {
    const left = Math.max(0, Math.floor(((b.expiresAt || 0) - Date.now()) / 1000));
    let name = b.type;
    if (b.type === "V") name = "Velocidade+";
    else if (b.type === "A") name = "Ataque+";
    else if (b.type === "M") name = "Movimento-";
    else if (b.type === "D") name = "Ataque-";
    return `${b.type} (${name}) - ${left}s`;
  }).join("\n");
  const posX = me ? Math.floor(me.x || 0) : 0;
  const posY = me ? Math.floor(me.y || 0) : 0;
  const lines = [
    `Posição: (${posX}, ${posY})`,
    `HP: ${stats.hp}`,
    `Velocidade base: ${stats.baseSpeed}`,
    `Velocidade efetiva: ${stats.effSpeed}`,
    `Ping Gateway: ${pingGatewayMs ?? "-"} ms`,
    `Ping Worker: ${pingWorkerMs ?? "-"} ms`,
    `Buffs ativos:`,
    buffsList || "Nenhum",
  ];
  box.textContent = lines.join("\n");
}

function startPing() {
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    lastPingTs = Date.now();
    ws.send(JSON.stringify({ type: "ping", payload: { ts: lastPingTs } }));
  }, 2000);
}

setInterval(() => { try { sendInput(); } catch (e) { } }, 200);

connect().catch(console.error);
loop();
let reconnecting = false;
let retryDelay = 200;
window.addEventListener("beforeunload", () => {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "leave" }));
    }
  } catch (e) { }
});

window.giveRandomBuffs = function (size) {
  const n = Math.max(0, parseInt(size || 0, 10) || 0);
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "give_buffs", payload: { size: n } }));
};

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
    players = next;
    projectiles = Array.isArray(msg.payload.projectiles) ? msg.payload.projectiles : [];
    buffItems = Array.isArray(msg.payload.buffItems) ? msg.payload.buffItems : [];
    isLoading = false;
    draw();
    updateSidebar();
    const me = players.get(playerId);
    if (me && me.dead && !deathShown) {
      showDeath(me.killerId);
    }
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
  const angle = Math.atan2(mouse.y - me.y, mouse.x - me.x);
  ws.send(JSON.stringify({ type: "input_attack", payload: { angle } }));
});

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (isLoading) {
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "16px sans-serif";
    ctx.fillText("Aguardando pod disponível...", 20, 30);
  }
  for (const [id, p] of players) {
    ctx.fillStyle = id === playerId ? "#4caf50" : "#2196f3";
    ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    const label = `${p.podId || "pod"}:${id}`;
    ctx.fillText(label, p.x - 10, p.y - 16);
    const rtt = latencyByPlayer.get(id);
    if (typeof rtt === "number") {
      ctx.fillText(`${Math.floor(rtt)} ms`, p.x - 10, p.y - 28);
    }

    if (typeof p.hp === "number" && typeof p.maxHp === "number") {
      const w = 26;
      const h = 4;
      const pct = Math.max(0, Math.min(1, p.hp / p.maxHp));
      ctx.fillStyle = "#700";
      ctx.fillRect(p.x - w / 2, p.y - 18, w, h);
      ctx.fillStyle = "#0f0";
      ctx.fillRect(p.x - w / 2, p.y - 18, Math.floor(w * pct), h);
      if (Array.isArray(p.buffs) && p.buffs.length > 0) {
        ctx.fillStyle = "#fff";
        ctx.font = "12px sans-serif";
        const text = (Array.isArray(p.buffs) ? p.buffs.map((b) => b.type).join("") : "");
        ctx.fillText(text, p.x - w / 2, p.y - 24);
      }
    }
  }

  for (const it of (buffItems || [])) {
    ctx.fillStyle = "#ffa500";
    ctx.beginPath();
    ctx.arc(it.x, it.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "10px sans-serif";
    ctx.fillText(it.type, it.x - 3, it.y - 8);
  }

  const me = players.get(playerId);
  if (me && !me.dead) {
    const angle = Math.atan2(mouse.y - me.y, mouse.x - me.x);
    ctx.save();
    ctx.translate(me.x, me.y);
    ctx.rotate(angle);
    ctx.fillStyle = "#ddd";
    ctx.fillRect(10, -3, 30, 6);
    ctx.restore();
  }

  for (const b of projectiles) {
    ctx.fillStyle = "#f00";
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
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
  for (const [id, p] of players) {
    if (id === playerId) continue;
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

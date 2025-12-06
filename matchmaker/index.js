const http = require("http");
const url = require("url");
const { createClient } = require("redis");
const k8s = require("@kubernetes/client-node");
const fs = require("fs");
const https = require("https");
const { makeLogger } = require("../common/logger");
const log = makeLogger("matchmaker");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PORT = process.env.MATCHMAKER_PORT ? parseInt(process.env.MATCHMAKER_PORT, 10) : 4000;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS_PER_POD || "1", 10);

const redis = createClient({ url: REDIS_URL });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function connectWithRetry() {
  for (let i = 0; i < 20; i++) {
    try { await redis.connect(); log.info("redis connected", { role: "matchmaker" }); return; }
    catch (e) { log.warn("redis connect retry", { attempt: i + 1 }); await sleep(500 * Math.min(10, i + 1)); }
  }
  throw new Error("redis connect failed");
}

async function choosePod() {
  const pods = await redis.sMembers("pods:active");
  let best = null;
  for (const p of pods) {
    const metrics = await redis.hGetAll(`pod:${p}:metrics`);
    const count = parseInt(metrics.playerCount || "0", 10);
    if (count < MAX_PLAYERS) {
      best = p;
      break;
    }
  }
  log.info("choosePod", { pods: pods.length, chosen: best });
  return best;
}

async function scaleUpGateway() {
  const ns = process.env.NAMESPACE || "default";
  const name = "gateway";
  const token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
  const ca = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
  const host = "kubernetes.default.svc";
  function req(path, method, body) {
    return new Promise((resolve, reject) => {
      const r = https.request({ hostname: host, port: 443, path, method, ca, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/merge-patch+json" } }, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
      });
      r.on("error", reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }
  const scale = await req(`/apis/apps/v1/namespaces/${ns}/deployments/${name}/scale`, "GET");
  const current = (scale?.spec?.replicas) || 1;
  const desired = current + 1;
  await req(`/apis/apps/v1/namespaces/${ns}/deployments/${name}/scale`, "PATCH", { spec: { replicas: desired } });
  log.warn("scaled gateway", { replicas: desired });
}

async function scaleDownGateway() {
  const ns = process.env.NAMESPACE || "default";
  const name = "gateway";
  const token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
  const ca = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
  const host = "kubernetes.default.svc";
  function req(path, method, body) {
    return new Promise((resolve, reject) => {
      const r = https.request({ hostname: host, port: 443, path, method, ca, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/merge-patch+json" } }, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
      });
      r.on("error", reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }
  const scale = await req(`/apis/apps/v1/namespaces/${ns}/deployments/${name}/scale`, "GET");
  const current = (scale?.spec?.replicas) || 1;
  const desired = Math.max(current - 1, 0);
  await req(`/apis/apps/v1/namespaces/${ns}/deployments/${name}/scale`, "PATCH", { spec: { replicas: desired } });
  log.warn("scaled down gateway", { replicas: desired });
}

async function waitForNewPod(prevCount) {
  for (let i = 0; i < 60; i++) {
    const pods = await redis.sMembers("pods:active");
    if (pods.length > prevCount) {
      for (const p of pods) {
        const metrics = await redis.hGetAll(`pod:${p}:metrics`);
        const count = parseInt(metrics.playerCount || "0", 10);
        if (count < MAX_PLAYERS) return p;
      }
    }
    log.info("waiting new pod", { attempt: i + 1 });
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function allocate() {
  const before = await redis.sMembers("pods:active");
  let podId = await choosePod();
  if (!podId) {
    try {
      await scaleUpGateway();
    } catch (e) { log.error("scaleUp failed", { error: String(e && e.message || e) }); }
    podId = await waitForNewPod(before.length);
  }
  const roomId = `room-${Math.random().toString(36).slice(2, 6)}`;
  log.info("allocate", { podId, roomId });
  return { podId, roomId };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }
  if (u.pathname === "/allocate") {
    const r = await allocate();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(r));
  } else if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true }));
  } else if (u.pathname === "/scaleDown") {
    try { await scaleDownGateway(); } catch (e) { log.error("scaleDown failed", { error: String(e && e.message || e) }); }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

async function start() {
  await connectWithRetry();
  server.listen(PORT, () => {
    log.info("listening", { port: PORT });
  });
}

start();

const { WebSocket } = require("ws");

async function openConn(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost:8080");
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", payload: { playerId: `p${i}` } }));
      resolve(ws);
    });
  });
}

async function run() {
  const N = parseInt(process.env.N || "100", 10);
  const conns = [];
  for (let i = 0; i < N; i++) {
    conns.push(await openConn(i));
  }
  console.log("opened", conns.length);
}

run().catch((e) => { console.error(e); process.exit(1); });

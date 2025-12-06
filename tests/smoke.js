const http = require("http");
const { WebSocket } = require("ws");

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

async function run() {
  const alloc = await httpGet("http://localhost:4000/allocate");
  const ws = new WebSocket("ws://localhost:8080");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "join", payload: { playerId: "p1", roomId: alloc.roomId } }));
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "assign_room") {
      console.log("assigned", msg.payload);
    }
    if (msg.type === "state_update") {
      console.log("update", msg.payload.players.length);
      ws.close();
    }
  });
}

run().catch((e) => { console.error(e); process.exit(1); });

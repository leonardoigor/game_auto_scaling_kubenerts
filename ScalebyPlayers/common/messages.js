const Types = {
  join: "join",
  start_game: "start_game",
  input_move: "input_move",
  input_attack: "input_attack",
  ping: "ping",
  pong_gateway: "pong_gateway",
  ping_worker: "ping_worker",
  pong_worker: "pong_worker",
  latency_report: "latency_report",
  latency_update: "latency_update",
  state_update: "state_update",
  leave: "leave",
  assign_room: "assign_room",
  busy_pod: "busy_pod",
};

function encode(type, payload) {
  return JSON.stringify({ type, payload });
}

function decode(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

module.exports = { Types, encode, decode };

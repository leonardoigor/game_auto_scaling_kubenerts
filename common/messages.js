const Types = {
  join: "join",
  start_game: "start_game",
  input_move: "input_move",
  input_attack: "input_attack",
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

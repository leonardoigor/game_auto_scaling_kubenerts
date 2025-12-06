function fmt(ts, level, mod, msg, extra) {
    const base = `${new Date(ts).toISOString()} ${level.toUpperCase()} ${mod} - ${msg}`;
    if (extra) return `${base} ${JSON.stringify(extra)}`;
    return base;
}

function makeLogger(mod) {
    const levelOrder = { debug: 10, info: 20, warn: 30, error: 40 };
    const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
    const min = levelOrder[envLevel] || 20;
    function log(level, msg, extra) {
        const ts = Date.now();
        const n = levelOrder[level] || 20;
        if (n < min) return;
        const line = fmt(ts, level, mod, msg, extra);
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
    }
    return {
        debug: (msg, extra) => log("debug", msg, extra),
        info: (msg, extra) => log("info", msg, extra),
        warn: (msg, extra) => log("warn", msg, extra),
        error: (msg, extra) => log("error", msg, extra),
    };
}

module.exports = { makeLogger };

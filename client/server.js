const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.CLIENT_PORT ? parseInt(process.env.CLIENT_PORT, 10) : 3000;

function serveFile(res, filePath, type) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (pathname === "/" || pathname === "/index.html") {
    serveFile(res, path.join(__dirname, "index.html"), "text/html");
  } else if (pathname === "/main.js") {
    serveFile(res, path.join(__dirname, "main.js"), "application/javascript");
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`client server on ${PORT}`);
  console.log(`Run http://localhost:${PORT}?room=123`);
});

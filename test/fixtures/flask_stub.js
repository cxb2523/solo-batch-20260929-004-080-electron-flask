"use strict";

// Stand-in for the Flask child process. Serves /healthz plus a few routes
// used to exercise the lifecycle: /hang never responds, /die exits the
// process shortly after responding.

const fs = require("fs");
const http = require("http");

const port = Number(process.env.FLASK_PORT || 4040);
const dieAfterMs = Number(process.env.DIE_AFTER_MS || 0);
const reqLog = process.env.REQ_LOG || "";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (reqLog) fs.appendFileSync(reqLog, req.url + "\n");
  if (req.url === "/hang") return; // never responds
  if (req.url === "/die") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("bye");
    setTimeout(() => process.exit(3), 25);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello:" + req.url);
});

server.listen(port, "127.0.0.1");

if (dieAfterMs > 0) setTimeout(() => process.exit(2), dieAfterMs);

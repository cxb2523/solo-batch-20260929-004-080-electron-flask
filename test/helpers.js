"use strict";

const http = require("http");

function waitForState(manager, state, timeoutMs = 10000) {
  return waitForStatus(manager, (status) => status.state === state, timeoutMs);
}

function waitForStatus(manager, predicate, timeoutMs = 10000) {
  if (predicate(manager.getStatus())) return Promise.resolve(manager.getStatus());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for status (current: "${manager.state}")`));
    }, timeoutMs);
    const onStatus = (status) => {
      if (predicate(status)) {
        cleanup();
        resolve(status);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      manager.off("status", onStatus);
    };
    manager.on("status", onStatus);
  });
}

function blockPort(port, host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("occupied");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

module.exports = { waitForState, waitForStatus, blockPort, closeServer };

"use strict";

const { EventEmitter } = require("events");
const http = require("http");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 40000) + 1000;
    this.killed = false;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal || "SIGTERM");
    this.killed = true;
    return true;
  }

  emitExit(code, signal) {
    this.emit("exit", code, signal);
  }

  emitError(error) {
    this.emit("error", error);
  }
}

function createHealthServer(port, statusCode) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(statusCode || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ echo: req.url }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.unref();
      resolve(server);
    });
  });
}

function createTcpListener(port) {
  const net = require("net");
  const server = net.createServer(() => {});
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.unref();
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

// Resolves once the manager reaches one of the given states.
function waitForState(manager, states) {
  const wanted = new Set(Array.isArray(states) ? states : [states]);
  return new Promise((resolve, reject) => {
    if (wanted.has(manager.state)) {
      resolve(manager.snapshot());
      return;
    }
    const onState = (snapshot) => {
      if (wanted.has(snapshot.state)) {
        manager.removeListener("state", onState);
        resolve(snapshot);
      }
    };
    manager.on("state", onState);
    manager.once("error", reject);
  });
}

function settled(promise) {
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
}

// Minimal fetch() replacement that never keeps a socket alive, so tests can
// exit cleanly without draining an undici global connection pool.
function nodeHttpFetch(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: (options && options.method) || "GET",
        headers: Object.assign(
          { Connection: "close" },
          (options && options.headers) || {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: res.headers,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", (error) => {
      if (options && options.signal && options.signal.aborted) {
        error.name = "AbortError";
      }
      reject(error);
    });
    if (options && options.signal) {
      options.signal.addEventListener("abort", () => req.destroy());
    }
    if (options && options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

module.exports = {
  FakeChild,
  createHealthServer,
  createTcpListener,
  closeServer,
  waitForState,
  settled,
  nodeHttpFetch,
};

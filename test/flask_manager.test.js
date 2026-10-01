"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FlaskManager } = require("../main/flask_manager");
const { createFlaskClient } = require("../renderer/flask_client");
const { waitForStatus, blockPort, closeServer } = require("./helpers");

const FIXTURE = path.join(__dirname, "fixtures", "flask_stub.js");

const stubSpec = (port, extraEnv = {}) => ({
  command: process.execPath,
  args: [FIXTURE],
  env: { ...process.env, FLASK_PORT: String(port), ...extraEnv },
});

const recordingBackoff = (delays) => (ms) => {
  delays.push(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
};

test("startup failure: retries with backoff, caps attempts, queued requests reject with error code, then recovers", async (t) => {
  const delays = [];
  let specFn = () => ({ command: "definitely-not-a-real-binary-080", args: [], env: {} });
  const manager = new FlaskManager({
    basePort: 24610,
    maxRetries: 2,
    backoffBaseMs: 10,
    probeIntervalMs: 5,
    probeTimeoutMs: 500,
    backoffSleep: recordingBackoff(delays),
    spawnForAttempt: (attempt, port) => specFn(attempt, port),
  });
  t.after(() => manager.stop());
  const client = createFlaskClient({
    queueTimeoutMs: 5000,
    initialStatus: manager.getStatus(),
  });
  manager.on("status", (status) => client.updateStatus(status));
  const states = [];
  manager.on("status", (status) => states.push(status.state));

  const queued = client.request("/echo");
  const started = manager.start();

  await assert.rejects(started, (err) => err.code === "FLASK_START_FAILED");
  await assert.rejects(queued, (err) => {
    assert.strictEqual(err.code, "FLASK_FAILED");
    return true;
  });
  assert.deepStrictEqual(states, ["starting", "retrying", "retrying", "failed"]);
  assert.deepStrictEqual(delays, [10, 20]); // exponential backoff
  assert.strictEqual(manager.state, "failed");

  // A failed manager must be able to recover, not stay stuck forever.
  specFn = (attempt, port) => stubSpec(port);
  await manager.restart();
  assert.strictEqual(manager.state, "ready");
  const res = await client.request("/echo");
  assert.strictEqual(res.body, "hello:/echo");

  await manager.stop();
});

test("unexpected exit: recovers automatically, in-flight requests reject, stale requests never reach the new process", async (t) => {
  const logFile = path.join(os.tmpdir(), `flask-stub-${process.pid}-${Date.now()}.log`);
  const manager = new FlaskManager({
    basePort: 24620,
    maxRetries: 3,
    backoffBaseMs: 10,
    probeIntervalMs: 5,
    probeTimeoutMs: 5000,
    spawnForAttempt: (attempt, port) => stubSpec(port, { REQ_LOG: logFile }),
  });
  t.after(() => manager.stop());
  const client = createFlaskClient({
    requestTimeoutMs: 5000,
    queueTimeoutMs: 5000,
    initialStatus: manager.getStatus(),
  });
  manager.on("status", (status) => client.updateStatus(status));

  await manager.start();
  assert.strictEqual(manager.state, "ready");
  assert.strictEqual(manager.generation, 1);

  const echo1 = await client.request("/echo");
  assert.strictEqual(echo1.body, "hello:/echo");

  // In-flight request that never completes on the old process.
  const hang = client.request("/hang");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const die = await client.request("/die");
  assert.strictEqual(die.status, 200);

  // The in-flight request must reject instead of hanging forever.
  await assert.rejects(hang, (err) =>
    ["FLASK_RESTARTED", "FLASK_NETWORK"].includes(err.code)
  );

  // The manager recovers by itself after the unexpected exit.
  const readyAgain = await waitForStatus(
    manager,
    (status) => status.state === "ready" && status.generation === 2
  );
  assert.strictEqual(readyAgain.lastExitCode, 3);

  const echo2 = await client.request("/echo2");
  assert.strictEqual(echo2.body, "hello:/echo2");

  await manager.stop();

  // The stale /hang request hit the old process exactly once and was never
  // re-dispatched to the respawned process.
  const log = fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.strictEqual(log.filter((line) => line === "/hang").length, 1);
  assert.strictEqual(log.filter((line) => line === "/echo2").length, 1);
  fs.unlinkSync(logFile);
});

test("port in use: retries on the next port with backoff, then broadcasts the real baseURL", async (t) => {
  const blocker = await blockPort(24630);
  t.after(() => closeServer(blocker));
  const delays = [];
  const manager = new FlaskManager({
    basePort: 24630,
    maxRetries: 3,
    backoffBaseMs: 10,
    probeIntervalMs: 5,
    probeTimeoutMs: 5000,
    backoffSleep: recordingBackoff(delays),
    spawnForAttempt: (attempt, port) => stubSpec(port),
  });
  t.after(() => manager.stop());
  const client = createFlaskClient({
    queueTimeoutMs: 5000,
    initialStatus: manager.getStatus(),
  });
  manager.on("status", (status) => client.updateStatus(status));

  // Queued while the manager probes/retries; must flush to the real baseURL.
  const queued = client.request("/echo");
  await manager.start();

  assert.strictEqual(manager.state, "ready");
  assert.strictEqual(manager.baseURL, "http://127.0.0.1:24631");
  assert.deepStrictEqual(delays, [10]);

  const res = await queued;
  assert.strictEqual(res.body, "hello:/echo");

  await manager.stop();
  await closeServer(blocker);
});

test("port in use: gives up after the retry cap, stays single-flight, queued requests reject", async (t) => {
  const blockers = await Promise.all([24640, 24641, 24642].map((port) => blockPort(port)));
  t.after(() => Promise.all(blockers.map(closeServer)));
  const delays = [];
  let spawnCalls = 0;
  const manager = new FlaskManager({
    basePort: 24640,
    maxRetries: 2,
    backoffBaseMs: 10,
    probeIntervalMs: 5,
    probeTimeoutMs: 500,
    backoffSleep: recordingBackoff(delays),
    spawnForAttempt: () => {
      spawnCalls += 1;
      return stubSpec(0);
    },
  });
  t.after(() => manager.stop());
  const client = createFlaskClient({
    queueTimeoutMs: 5000,
    initialStatus: manager.getStatus(),
  });
  manager.on("status", (status) => client.updateStatus(status));

  const queued = client.request("/echo");
  const first = manager.start();
  const second = manager.start();
  assert.strictEqual(first, second, "concurrent start() must be single-flight");

  await assert.rejects(
    first,
    (err) => err.code === "FLASK_START_FAILED" && /already in use/.test(err.message)
  );
  await assert.rejects(queued, (err) => err.code === "FLASK_FAILED");
  assert.strictEqual(spawnCalls, 0, "busy ports must be skipped without spawning");
  assert.deepStrictEqual(delays, [10, 20], "exponential backoff between retries");
  assert.strictEqual(manager.state, "failed");

  await Promise.all(blockers.map(closeServer));
});

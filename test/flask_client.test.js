"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createFlaskClient } = require("../renderer/flask_client");

const STARTING = { state: "starting", attempt: 0, maxRetries: 5, lastExitCode: null, lastError: null, baseURL: null };
const readyOn = (port) => ({
  state: "ready",
  attempt: 1,
  maxRetries: 5,
  lastExitCode: null,
  lastError: null,
  baseURL: `http://127.0.0.1:${port}`,
});

const fakeResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "OK",
  headers: {},
  text: async () => body,
});

const hangFetch = (calls) => (url, init) =>
  new Promise((_resolve, reject) => {
    calls.push(url);
    init.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    );
  });

test("queues requests while not ready and flushes them to the real baseURL once ready", async () => {
  const calls = [];
  const client = createFlaskClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return fakeResponse(200, "ok");
    },
    initialStatus: STARTING,
  });

  const pending = client.request("/api");
  assert.strictEqual(client.pendingCount(), 1);

  client.updateStatus(readyOn(4041));
  const res = await pending;
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(calls, ["http://127.0.0.1:4041/api"]);
});

test("rejects queued and new requests with an error code when the backend fails", async () => {
  let fetchCalls = 0;
  const client = createFlaskClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      return fakeResponse(200, "ok");
    },
    initialStatus: STARTING,
  });

  const queued = client.request("/api");
  client.updateStatus({ ...STARTING, state: "failed", lastExitCode: 1, lastError: "boom" });

  await assert.rejects(queued, (err) => {
    assert.strictEqual(err.code, "FLASK_FAILED");
    assert.strictEqual(err.exitCode, 1);
    return true;
  });

  await assert.rejects(client.request("/api"), (err) => err.code === "FLASK_FAILED");
  assert.strictEqual(fetchCalls, 0, "failed backend must not receive requests");
});

test("queued requests time out instead of waiting forever", async () => {
  const client = createFlaskClient({
    fetchImpl: async () => fakeResponse(200, "ok"),
    queueTimeoutMs: 30,
    initialStatus: STARTING,
  });
  await assert.rejects(client.request("/api"), (err) => err.code === "FLASK_QUEUE_TIMEOUT");
  assert.strictEqual(client.pendingCount(), 0);
});

test("cancels in-flight requests on restart and never sends stale requests to the new process", async () => {
  const calls = [];
  const client = createFlaskClient({
    fetchImpl: hangFetch(calls),
    initialStatus: readyOn(4040),
  });

  const inflight = client.request("/hang");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(calls, ["http://127.0.0.1:4040/hang"]);

  client.updateStatus({ ...STARTING, state: "retrying", lastExitCode: 2 });
  await assert.rejects(inflight, (err) => {
    assert.strictEqual(err.code, "FLASK_RESTARTED");
    assert.strictEqual(err.exitCode, 2);
    return true;
  });

  // Backend comes back on a new port: only new requests go there.
  client.updateStatus(readyOn(4041));
  const fresh = client.request("/x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(calls, ["http://127.0.0.1:4040/hang", "http://127.0.0.1:4041/x"]);

  client.updateStatus({ ...STARTING, state: "failed", lastError: "gone" });
  await assert.rejects(fresh, (err) => err.code === "FLASK_FAILED");
});

test("in-flight requests time out instead of hanging forever", async () => {
  const client = createFlaskClient({
    fetchImpl: hangFetch([]),
    requestTimeoutMs: 30,
    initialStatus: readyOn(4040),
  });
  await assert.rejects(client.request("/slow"), (err) => err.code === "FLASK_REQUEST_TIMEOUT");
});

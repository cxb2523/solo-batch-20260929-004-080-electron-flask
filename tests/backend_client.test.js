"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { BackendClient } = require("../backend_client");
const { ERR } = require("../package_python");
const { settled, nodeHttpFetch } = require("./helpers");

function snapshot(overrides) {
  return Object.assign(
    {
      state: "starting",
      baseURL: null,
      port: 4040,
      generation: 1,
      attempt: 0,
      restartCount: 0,
      lastExitCode: null,
      lastError: null,
    },
    overrides
  );
}

test("未就绪时请求进入待发队列，ready 后按真实 baseURL 自动发出", async () => {
  const requests = [];
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      requests.push({ url, options });
      if (options && options.signal) {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
      resolve({ ok: true, url, status: 200 });
    });
  const client = new BackendClient({ fetch: fetchImpl });

  const promise = client.request("/dashboard");
  assert.equal(await settled(promise), false, "未就绪时请求必须挂在队列中");
  assert.equal(client.getStatus().pending, 1);

  client.handleState(
    snapshot({
      state: "ready",
      baseURL: "http://127.0.0.1:4040",
    })
  );

  const response = await promise;
  assert.equal(response.status, 200);
  assert.equal(requests[0].url, "http://127.0.0.1:4040/dashboard");
  assert.equal(client.getStatus().pending, 0);
});

test("链路一：启动失败 failed -> 队列请求被拒绝且错误码透传，不悬挂", async () => {
  const client = new BackendClient({ fetch: () => Promise.resolve() });
  const promise = client.request("/dashboard", { timeoutMs: 5000 });

  client.handleState(
    snapshot({
      state: "failed",
      generation: 1,
      attempt: 3,
      lastExitCode: 7,
      lastError: { code: ERR.START_FAILED, message: "backend exited before becoming ready" },
    })
  );

  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error.code, ERR.START_FAILED);
      assert.equal(error.exitCode, 7);
      return true;
    }
  );
  assert.equal(client.getStatus().pending, 0);

  // Requests issued after failure reject immediately, never hang.
  await assert.rejects(client.request("/x"), (error) => {
    assert.equal(error.code, ERR.START_FAILED);
    return true;
  });
});

test("链路三：端口占用重试上限 failed -> RETRY_LIMIT 透传", async () => {
  const client = new BackendClient({ fetch: () => Promise.resolve() });
  const promise = client.request("/");

  client.handleState(
    snapshot({
      state: "retrying",
      generation: 1,
      attempt: 1,
      lastError: { code: "ERR_PORT_IN_USE", message: "port 4040 is already in use" },
    })
  );
  assert.equal(await settled(promise), false, "retrying 期间请求继续排队等待");

  client.handleState(
    snapshot({
      state: "failed",
      generation: 1,
      attempt: 3,
      lastError: { code: ERR.RETRY_LIMIT, message: "port remained in use" },
    })
  );

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, ERR.RETRY_LIMIT);
    return true;
  });
});

test("链路二：异常退出进入新代际，旧请求被拒绝且不会打到新进程", async () => {
  const fetchCalls = [];
  const fetchImpl = (url, options) => {
    fetchCalls.push(url);
    if (url.endsWith("/new")) {
      return Promise.resolve({ ok: true, status: 200 });
    }
    return new Promise((_resolve, reject) => {
      // Old-process request only settles (as aborted) when the signal fires.
      if (options && options.signal) {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
    });
  };
  const client = new BackendClient({ fetch: fetchImpl });

  client.handleState(
    snapshot({
      state: "ready",
      baseURL: "http://127.0.0.1:4040",
      generation: 1,
    })
  );
  const inflightRequest = client.request("/old", { timeoutMs: 5000 });
  assert.equal(fetchCalls[0], "http://127.0.0.1:4040/old");

  // Process exits; manager moves to retrying and bumps the generation.
  client.handleState(
    snapshot({
      state: "retrying",
      baseURL: null,
      generation: 2,
      restartCount: 1,
      lastExitCode: 13,
      lastError: { code: ERR.EXITED, message: "backend exited unexpectedly" },
    })
  );

  await assert.rejects(inflightRequest, (error) => {
    assert.equal(error.code, ERR.RESTARTED);
    return true;
  });

  // A queued request made during retrying is stamped gen 2 and survives.
  const newRequest = client.request("/new", { timeoutMs: 5000 });
  assert.equal(await settled(newRequest), false);

  client.handleState(
    snapshot({
      state: "ready",
      baseURL: "http://127.0.0.1:4040",
      generation: 2,
      restartCount: 1,
    })
  );

  const response = await newRequest;
  assert.equal(response.ok, true);
  assert.deepEqual(fetchCalls, [
    "http://127.0.0.1:4040/old",
    "http://127.0.0.1:4040/new",
  ]);
});

test("同代际内的 starting 重试不会误杀排队请求", async () => {
  const fetchImpl = () => Promise.resolve({ ok: true, status: 200 });
  const client = new BackendClient({ fetch: fetchImpl });

  const promise = client.request("/dashboard", { timeoutMs: 5000 });
  client.handleState(snapshot({ state: "retrying", generation: 1, attempt: 1 }));
  client.handleState(snapshot({ state: "retrying", generation: 1, attempt: 2 }));
  assert.equal(await settled(promise), false);

  client.handleState(
    snapshot({
      state: "ready",
      baseURL: "http://127.0.0.1:4040",
      generation: 1,
    })
  );
  const response = await promise;
  assert.equal(response.status, 200);
});

test("链路二：异常退出后恢复也失败 -> failed 统一按失败错误码拒绝，旧请求不悬挂", async () => {
  const fetchImpl = (_url, options) =>
    new Promise((_resolve, reject) => {
      if (options && options.signal) {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
    });
  const client = new BackendClient({ fetch: fetchImpl });

  client.handleState(
    snapshot({
      state: "ready",
      baseURL: "http://127.0.0.1:4040",
      generation: 1,
    })
  );
  const oldRequest = client.request("/old", { timeoutMs: 5000 });

  // Exit triggers a new era...
  client.handleState(
    snapshot({
      state: "retrying",
      baseURL: null,
      generation: 2,
      restartCount: 1,
      lastExitCode: 13,
      lastError: { code: ERR.EXITED, message: "backend exited unexpectedly" },
    })
  );
  // ...and the recovery window exhausts into failed. The old request must
  // surface the terminal failure code, never hang.
  client.handleState(
    snapshot({
      state: "failed",
      baseURL: null,
      generation: 2,
      restartCount: 1,
      lastExitCode: 1,
      lastError: {
        code: ERR.START_FAILED,
        message: "backend did not start",
      },
    })
  );

  await assert.rejects(oldRequest, (error) => {
    assert.equal(error.code, ERR.START_FAILED);
    return true;
  });
});

test("请求级超时兜底：不会无限等待", async () => {
  const client = new BackendClient({
    fetch: (_url, options) =>
      new Promise((_resolve, reject) => {
        if (options && options.signal) {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      }),
    requestTimeoutMs: 30,
  });
  client.handleState(
    snapshot({
      state: "ready",
      baseURL: "http://127.0.0.1:4040",
      generation: 1,
    })
  );
  await assert.rejects(client.request("/slow"), (error) => {
    assert.equal(error.code, ERR.TIMEOUT);
    return true;
  });
});

test("端到端：真实 HTTP 服务 ready 后请求拿到响应", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const client = new BackendClient({
    fetch: nodeHttpFetch,
    requestTimeoutMs: 5000,
  });
  const promise = client.request("/ping");
  client.handleState(
    snapshot({
      state: "ready",
      baseURL: "http://127.0.0.1:" + port,
      generation: 1,
    })
  );
  const response = await promise;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.path, "/ping");

  await new Promise((resolve) => server.close(resolve));
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { BackendManager, STATE, ERR } = require("../package_python");
const {
  FakeChild,
  createHealthServer,
  closeServer,
  waitForState,
} = require("./helpers");

const TEST_OPTIONS = {
  maxAttempts: 3,
  maxRestarts: 2,
  probeTimeoutMs: 600,
  backoffBaseMs: 5,
  backoffMaxMs: 50,
};

test("链路一：启动反复失败 -> failed，错误码透传，不会无限重试", async () => {
  const launched = [];
  const sleeps = [];
  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      isPortBusy: async () => false,
      sleep: (ms) => sleeps.push(ms),
      launchChild: () => {
        const child = new FakeChild();
        launched.push(child);
        // Fail "immediately" without actually killing the process here.
        setImmediate(() => child.emitExit(7));
        return child;
      },
      waitForHealth: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        const error = new Error("health check timed out");
        error.code = ERR.TIMEOUT;
        throw error;
      },
      treeKill: () => {},
    })
  );

  const states = [];
  manager.on("state", (snapshot) => states.push(snapshot.state));

  await manager.start();

  assert.equal(manager.state, STATE.FAILED);
  assert.equal(launched.length, TEST_OPTIONS.maxAttempts);
  assert.ok(states.includes(STATE.RETRYING));
  assert.deepEqual(
    states.filter((state) => state !== STATE.STARTING),
    [
      STATE.RETRYING,
      STATE.RETRYING,
      STATE.RETRYING,
      STATE.RETRYING,
      STATE.FAILED,
    ]
  );
  assert.equal(manager.lastExitCode, 7);
  // Bounded exponential backoff, never infinite.
  assert.deepEqual(sleeps.filter((ms) => ms > 0), [5, 10]);
  const finalError = manager.lastError;
  assert.ok(
    [ERR.START_FAILED, ERR.RETRY_LIMIT].includes(finalError.code),
    "expected a bounded failure code, got " + finalError.code
  );
});

test("链路一：launcher 抛错（如 ENOENT）也会重试并失败", async () => {
  let attempts = 0;
  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      isPortBusy: async () => false,
      sleep: async () => {},
      launchChild: () => {
        attempts += 1;
        const error = new Error("spawn python ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    })
  );

  await manager.start();
  assert.equal(manager.state, STATE.FAILED);
  assert.equal(attempts, TEST_OPTIONS.maxAttempts);
  assert.equal(manager.lastError.code, "ENOENT");
});

test("链路二：ready 后子进程意外退出 -> retrying，恢复进程始终起不来则按上限 failed", async () => {
  // Grab a free port up front, then release it so the first process can bind.
  const seat = await createHealthServer(0);
  const port = seat.address().port;
  await closeServer(seat);

  let launchIndex = 0;
  let liveServer = null;
  let exitedDuringReady = false;

  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      port,
      probeTimeoutMs: 120,
      backoffBaseMs: 2,
      backoffMaxMs: 10,
      isPortBusy: async () => false,
      sleep: async () => {},
      launchChild: () => {
        const child = new FakeChild();
        launchIndex += 1;
        const index = launchIndex;
        setImmediate(async () => {
          if (index === 1) {
            liveServer = await createHealthServer(port);
            setTimeout(() => {
              exitedDuringReady = true;
              closeServer(liveServer).then(() => {
                liveServer = null;
                child.emitExit(13);
              });
            }, 20);
          } else {
            // Recovery processes crash immediately on every attempt.
            setImmediate(() => child.emitExit(1));
          }
        });
        return child;
      },
      treeKill: () => {},
    })
  );

  manager.start();
  await waitForState(manager, STATE.READY);
  assert.equal(manager.state, STATE.READY);
  assert.equal(manager.baseURL, "http://127.0.0.1:" + port);

  await waitForState(manager, STATE.FAILED);
  assert.equal(manager.state, STATE.FAILED);
  assert.equal(exitedDuringReady, true);
  assert.equal(manager.lastExitCode, 1);
  assert.equal(manager.restartCount, 1, "退出后必须进入恢复窗口并计一次重启");
  assert.ok(
    launchIndex > 1,
    "恢复窗口内必须重新拉起进程，而不是永久卡死"
  );
  assert.equal(manager.lastError.code, ERR.START_FAILED);
});

test("链路二补充：ready 后退出且重启窗口内恢复成功", async () => {
  // Use a fixed free port chosen up front for deterministic recovery.
  const probeServer = await createHealthServer(0);
  const port = probeServer.address().port;
  await closeServer(probeServer);

  const children = [];
  let launchIndex = 0;
  let liveServer = null;

  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      port,
      probeTimeoutMs: 2000,
      isPortBusy: async () => false,
      sleep: async () => {},
      launchChild: () => {
        const child = new FakeChild();
        launchIndex += 1;
        children.push(child);
        const index = launchIndex;
        setImmediate(async () => {
          liveServer = await createHealthServer(port);
          if (index === 1) {
            setTimeout(() => {
              closeServer(liveServer);
              liveServer = null;
              child.emitExit(9);
            }, 20);
          }
        });
        return child;
      },
      treeKill: () => {},
    })
  );

  manager.start();
  await waitForState(manager, STATE.READY);

  await waitForState(manager, [STATE.READY, STATE.FAILED]);
  // Wait through the recovery cycle explicitly.
  const recovered = await new Promise((resolve) => {
    const check = () => {
      if (manager.state === STATE.READY && manager.restartCount >= 1) {
        resolve(true);
      } else if (manager.state === STATE.FAILED) {
        resolve(false);
      } else {
        setTimeout(check, 10);
      }
    };
    setTimeout(check, 10);
  });

  assert.equal(recovered, true, "异常退出后必须能够恢复到 ready");
  assert.equal(manager.state, STATE.READY);
  assert.equal(manager.restartCount, 1);
  assert.equal(manager.lastExitCode, 9);
  assert.equal(launchIndex, 2, "恢复时应只拉起一个新进程");

  await closeServer(liveServer);
});

test("链路三：端口被占用 -> 指数退避重试，释放后 ready", async () => {
  let launches = 0;
  const sleeps = [];
  let healthServer = null;
  let busy = true;
  const seat = await createHealthServer(0);
  const port = seat.address().port;
  await closeServer(seat);

  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      port,
      probeTimeoutMs: 2000,
      isPortBusy: async () => busy,
      probeSleep: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
        // Release exactly once, inside the first exponential backoff: the
        // next loop iteration must then observe a free port.
        if (sleeps.length === 1) {
          busy = false;
        }
      },
      launchChild: () => {
        launches += 1;
        const child = new FakeChild();
        setImmediate(async () => {
          healthServer = await createHealthServer(port);
        });
        return child;
      },
      treeKill: () => {},
    })
  );

  manager.start();
  await waitForState(manager, STATE.READY);

  assert.equal(launches, 1, "端口占用期间不得拉起子进程");
  assert.deepEqual(sleeps, [5]);
  assert.equal(manager.baseURL, "http://127.0.0.1:" + port);

  await closeServer(healthServer);
});

test("链路三：端口持续被占用 -> 次数上限后 failed，错误码为 RETRY_LIMIT", async () => {
  let launches = 0;
  const sleeps = [];

  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      isPortBusy: async () => true,
      probeSleep: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      launchChild: () => {
        launches += 1;
        return new FakeChild();
      },
    })
  );

  await manager.start();

  assert.equal(manager.state, STATE.FAILED);
  assert.equal(launches, 0);
  assert.equal(manager.lastError.code, ERR.RETRY_LIMIT);
  assert.equal(manager.attempt, TEST_OPTIONS.maxAttempts);
  // Exponential backoff: 5, 10 (third attempt hits the cap, no sleep).
  assert.deepEqual(sleeps, [5, 10]);
});

test("同一次启动只允许一个探测流程：并发 start 不重复拉起", async () => {
  const seat = await createHealthServer(0);
  const port = seat.address().port;
  await closeServer(seat);

  let launches = 0;
  let healthServer = null;
  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      port,
      probeTimeoutMs: 2000,
      isPortBusy: async () => false,
      sleep: async () => {},
      launchChild: () => {
        launches += 1;
        const child = new FakeChild();
        setImmediate(async () => {
          healthServer = await createHealthServer(port);
        });
        return child;
      },
      treeKill: () => {},
    })
  );

  await Promise.all([manager.start(), manager.start(), manager.start()]);

  assert.equal(launches, 1);
  assert.equal(manager.state, STATE.READY);

  await closeServer(healthServer);
});

test("stop() 使等待中的启动终止并进入 failed", async () => {
  let launches = 0;
  const manager = new BackendManager(
    Object.assign({}, TEST_OPTIONS, {
      isPortBusy: async () => false,
      sleep: async () => new Promise(() => {}),
      launchChild: () => {
        launches += 1;
        const child = new FakeChild();
        setImmediate(() => child.emitExit(1));
        return child;
      },
      waitForHealth: async (_url, signal) => {
        await new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { aborted: true }));
            });
          }
        });
      },
      treeKill: () => {},
    })
  );

  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.stop();

  assert.equal(manager.state, STATE.FAILED);
  assert.equal(manager.lastError.code, ERR.STOPPED);
});

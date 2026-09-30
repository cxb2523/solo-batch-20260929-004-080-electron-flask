"use strict";

/**
 * Two responsibilities live in this file:
 *
 * 1. BackendManager - the single source of truth for the Flask child
 *    process lifecycle (starting / ready / retrying / failed). It performs
 *    port probing with bounded exponential backoff, guarantees that only one
 *    launch+probe flow runs per start(), invalidates every request that
 *    belonged to a dead process, and recovers from unexpected exits.
 *
 * 2. The original PyInstaller packaging CLI, preserved for
 *    `node package_python.js`. It only runs when this file is executed
 *    directly, so `require("./package_python")` is side effect free.
 */

const { EventEmitter } = require("events");
const http = require("http");
const net = require("net");
const path = require("path");

const STATE = Object.freeze({
  STARTING: "starting",
  READY: "ready",
  RETRYING: "retrying",
  FAILED: "failed",
});

const ERR = Object.freeze({
  START_FAILED: "ERR_BACKEND_START_FAILED",
  EXITED: "ERR_BACKEND_EXITED",
  RETRY_LIMIT: "ERR_BACKEND_RETRY_LIMIT",
  RESTART_LIMIT: "ERR_BACKEND_RESTART_LIMIT",
  RESTARTED: "ERR_BACKEND_RESTARTED",
  TIMEOUT: "ERR_BACKEND_TIMEOUT",
  STOPPED: "ERR_BACKEND_STOPPED",
});

const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 4040,
  healthPath: "/health",
  maxAttempts: 5,
  maxRestarts: 5,
  probeTimeoutMs: 3000,
  probeIntervalMs: 150,
  backoffBaseMs: 100,
  backoffMaxMs: 3000,
});

const defaultSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isPortBusy(host, port, socketFactory) {
  const createConnection = socketFactory || net.createConnection;
  return new Promise((resolve) => {
    let settled = false;
    const done = (busy) => {
      if (!settled) {
        settled = true;
        if (!socket.destroyed) {
          socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy();
        }
        resolve(busy);
      }
    };
    const socket = createConnection({ host, port }, () => done(true));
    socket.unref();
    socket.once("error", () => {
      done(false);
    });
    socket.setTimeout(1000, () => {
      done(false);
    });
  });
}

function httpGet(url, requestFactory, signal) {
  const request = requestFactory || http.request;
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    const onAbort = () => {
      req.destroy(
        Object.assign(new Error("probe aborted"), { aborted: true })
      );
    };
    req.once("error", reject);
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    req.end();
  });
}

function abortError() {
  return Object.assign(new Error("probe aborted"), {
    code: ERR.STOPPED,
    aborted: true,
  });
}

async function waitForHealth(
  baseURL,
  timeoutMs,
  requestFactory,
  sleepFn,
  signal
) {
  const sleep = sleepFn || defaultSleep;
  const started = Date.now();
  const waitAbort = () =>
    new Promise((resolve) => {
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      signal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      });
    });
  while (Date.now() - started < timeoutMs) {
    if (signal && signal.aborted) {
      throw abortError();
    }
    try {
      const statusCode = await Promise.race([
        httpGet(baseURL, requestFactory, signal),
        waitAbort(),
      ]);
      if (statusCode === "aborted") {
        throw abortError();
      }
      if (statusCode >= 200 && statusCode < 300) {
        return;
      }
    } catch (error) {
      if (signal && signal.aborted) {
        throw abortError();
      }
      // not reachable yet
    }
    await Promise.race([sleep(DEFAULTS.probeIntervalMs), waitAbort()]);
    if (signal && signal.aborted) {
      throw abortError();
    }
  }
  throw Object.assign(new Error("health check timed out"), {
    code: ERR.TIMEOUT,
  });
}

function defaultTreeKill(child) {
  if (!child || !child.pid || child.killed) {
    return;
  }
  let psTree;
  try {
    psTree = require("ps-tree");
  } catch (_) {
    psTree = null;
  }
  if (psTree) {
    psTree(child.pid, (error, children) => {
      if (!error) {
        children.forEach((entry) => {
          try {
            process.kill(entry.PID);
          } catch (_) {
            // already gone
          }
        });
      }
      try {
        child.kill();
      } catch (_) {
        // already gone
      }
    });
  } else {
    try {
      child.kill();
    } catch (_) {
      // already gone
    }
  }
}

class BackendManager extends EventEmitter {
  constructor(options) {
    super();
    const config = Object.assign({}, DEFAULTS, options || {});
    this.host = config.host;
    this.preferredPort = config.port;
    this.healthPath = config.healthPath;
    this.maxAttempts = config.maxAttempts;
    this.maxRestarts = config.maxRestarts;
    this.probeTimeoutMs = config.probeTimeoutMs;
    this.backoffBaseMs = config.backoffBaseMs;
    this.backoffMaxMs = config.backoffMaxMs;
    this.launchChild = config.launchChild;
    this.treeKill = config.treeKill || defaultTreeKill;
    this.isPortBusy = config.isPortBusy || isPortBusy;
    this.sleep = config.sleep || defaultSleep;
    this.probeSleep = config.probeSleep || this.sleep;
    this.waitForHealth =
      config.waitForHealth ||
      ((url, signal) =>
        waitForHealth(
          url,
          this.probeTimeoutMs,
          config.requestFactory,
          this.probeSleep,
          signal
        ));
    this.state = STATE.STARTING;
    this.baseURL = null;
    this.port = null;
    // Generation identifies one process era. It only changes when a new
    // process is launched, never while retrying within the same startup.
    this.generation = 0;
    this.attempt = 0;
    this.restartCount = 0;
    this.lastExitCode = null;
    this.lastError = null;
    this.child = null;
    this.starting = false;
    this.runToken = 0;
    this.probeAbort = null;
    this.served = false;
  }

  snapshot() {
    return {
      state: this.state,
      baseURL: this.baseURL,
      port: this.port,
      generation: this.generation,
      attempt: this.attempt,
      restartCount: this.restartCount,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError
        ? { code: this.lastError.code, message: this.lastError.message }
        : null,
    };
  }

  setState(state, extra) {
    this.state = state;
    if (extra) {
      Object.assign(this, extra);
    }
    this.emit("state", this.snapshot());
  }

  async start() {
    // Single-flight: a startup cycle may only ever run one launch + probe
    // flow, so concurrent callers never spawn duplicate processes.
    if (this.starting) {
      return;
    }
    if (
      this.state === STATE.READY ||
      this.state === STATE.RETRYING
    ) {
      return;
    }
    // STARTING only counts as "already running" once a cycle is active; the
    // initial state (before the first start()) must remain startable.
    if (this.state === STATE.STARTING && this.runToken > 0) {
      return;
    }
    this.starting = true;
    const token = ++this.runToken;
    this.attempt = 0;
    this.restartCount = 0;
    this.lastExitCode = null;
    this.lastError = null;
    this.baseURL = null;
    this.port = null;
    this.served = false;
    // Bump once for the upcoming first launch. Clients primed by an earlier
    // failed cycle are rejected by this generation.
    this.generation += 1;
    this.setState(STATE.STARTING);
    try {
      await this._runCycle(token);
    } finally {
      if (this.runToken === token) {
        this.starting = false;
      }
    }
  }

  async stop() {
    this.runToken += 1;
    this.starting = false;
    if (this.probeAbort) {
      this.probeAbort.abort();
      this.probeAbort = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      this.treeKill(child);
    }
    this.baseURL = null;
    this.port = null;
    this.served = false;
    this.lastError = Object.assign(new Error("backend stopped"), {
      code: ERR.STOPPED,
    });
    this.setState(STATE.FAILED);
  }

  async _runCycle(token) {
    let delayMs = 0;
    while (this.runToken === token) {
      if (this.attempt >= this.maxAttempts) {
        this.lastError = Object.assign(
          new Error(
            "backend did not start after " + this.maxAttempts + " attempts"
          ),
          { code: ERR.RETRY_LIMIT, exitCode: this.lastExitCode }
        );
        this.setState(STATE.FAILED);
        return;
      }

      if (delayMs > 0) {
        this.setState(STATE.RETRYING);
        await this.sleep(delayMs);
        if (this.runToken !== token) {
          return;
        }
      }

      const port = this.preferredPort;
      if (await this.isPortBusy(this.host, port)) {
        // Port held by a stale process or another app. The child would fail
        // to bind, so back off and retry without launching anything.
        this.attempt += 1;
        this.lastError = Object.assign(
          new Error("port " + port + " is already in use"),
          { code: "ERR_PORT_IN_USE", port }
        );
        if (this.attempt >= this.maxAttempts) {
          this.lastError = Object.assign(
            new Error(
              "port " +
                port +
                " remained in use after " +
                this.maxAttempts +
                " attempts"
            ),
            { code: ERR.RETRY_LIMIT, port }
          );
          this.setState(STATE.FAILED);
          return;
        }
        delayMs = Math.min(
          this.backoffMaxMs,
          this.backoffBaseMs * Math.pow(2, this.attempt - 1)
        );
        this.setState(STATE.RETRYING);
        continue;
      }

      delayMs = 0;
      const outcome = await this._launchAndProbe(token, port);
      if (this.runToken !== token) {
        return;
      }
      if (outcome === "ready" || outcome === "fatal") {
        return;
      }
      // outcome === "retry": _launchAndProbe already counted the attempt;
      // just enforce the cap and schedule exponential backoff.
      if (this.attempt >= this.maxAttempts) {
        const exhausted = new Error(
          "backend did not start after " + this.maxAttempts + " attempts"
        );
        // Preserve the concrete failure code (e.g. ENOENT) from the last
        // attempt instead of masking it behind a generic one.
        exhausted.code =
          this.lastError && this.lastError.code
            ? this.lastError.code
            : ERR.START_FAILED;
        exhausted.exitCode = this.lastExitCode;
        exhausted.cause = this.lastError;
        this.lastError = exhausted;
        this.setState(STATE.FAILED);
        return;
      }
      delayMs = Math.min(
        this.backoffMaxMs,
        this.backoffBaseMs * Math.pow(2, this.attempt - 1)
      );
    }
  }

  async _launchAndProbe(token, port) {
    this.attempt += 1;
    this.lastError = null;
    const isRetry = this.served || this.attempt > 1;
    this.setState(isRetry ? STATE.RETRYING : STATE.STARTING);
    const probeAbort =
      typeof AbortController === "function" ? new AbortController() : null;
    this.probeAbort = probeAbort;

    let child;
    try {
      child = this.launchChild({
        host: this.host,
        port,
        generation: this.generation,
      });
    } catch (error) {
      this.lastError = Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { code: error && error.code ? error.code : ERR.START_FAILED }
      );
      return "retry";
    }

    this.child = child;
    // Requests stamped with this generation belong to this process era.
    // The generation only changes between startup cycles (manual start or
    // recovery after a ready process exited), never between retries.
    const generation = this.generation;
    let exitInfo = null;
    let exitHandled = false;

    const onExit = (code, signal) => {
      if (exitHandled) {
        return;
      }
      exitHandled = true;
      exitInfo = { code: code == null ? null : code, signal: signal || null };
      this.lastExitCode = code == null ? null : code;
      if (this.child === child) {
        this.child = null;
      }
      if (this.state === STATE.READY && this.runToken === token) {
        // Died mid-flight: outstanding requests target a dead port, so
        // invalidate the era and recover with a fresh cycle.
        this.baseURL = null;
        this.port = null;
        this.served = false;
        this._scheduleRestart(token, generation, exitInfo);
      }
    };
    child.once("exit", onExit);
    child.once("error", (error) => {
      this.lastError = error;
      // 'error' is usually followed by 'exit'; when it is not, synthesise
      // one so the probe loop reacts immediately instead of hanging.
      if (exitInfo === null) {
        onExit(null, null);
      }
    });

    const baseURL = "http://" + this.host + ":" + port + this.healthPath;
    try {
      await this.waitForHealth(baseURL, probeAbort && probeAbort.signal);
    } catch (error) {
      if (this.runToken !== token) {
        return "fatal";
      }
      if (error && error.aborted) {
        return "fatal";
      }
      if (exitInfo !== null) {
        this.lastError = Object.assign(
          new Error("backend exited before becoming ready"),
          {
            code: ERR.START_FAILED,
            exitCode: exitInfo.code,
            signal: exitInfo.signal,
          }
        );
      } else {
        this.lastError = Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { code: error && error.code ? error.code : ERR.TIMEOUT }
        );
        // Probe gave up while the process is still alive; kill it so the
        // retry starts from a clean slate.
        this.treeKill(child);
      }
      return "retry";
    }

    if (exitInfo !== null) {
      // Exited in the gap between the last probe and this check.
      this.lastError = Object.assign(
        new Error("backend exited immediately after becoming ready"),
        {
          code: ERR.START_FAILED,
          exitCode: exitInfo.code,
          signal: exitInfo.signal,
        }
      );
      return "retry";
    }

    if (this.runToken !== token) {
      this.treeKill(child);
      return "fatal";
    }

    this.served = true;
    const readyURL = "http://" + this.host + ":" + port;
    this.setState(STATE.READY, { baseURL: readyURL, port });
    return "ready";
  }

  async _scheduleRestart(token, generation, exitInfo) {
    // Recovery starts a brand new process era: bump the generation so no
    // request stamped for the dead process can land on the new one.
    this.generation += 1;
    const newGeneration = this.generation;
    if (this.restartCount >= this.maxRestarts) {
      this.lastError = Object.assign(
        new Error(
          "backend exited and the restart limit (" +
            this.maxRestarts +
            ") was reached"
        ),
        {
          code: ERR.RESTART_LIMIT,
          exitCode: exitInfo ? exitInfo.code : this.lastExitCode,
        }
      );
      this.setState(STATE.FAILED);
      return;
    }
    this.restartCount += 1;
    this.lastError = Object.assign(
      new Error("backend exited unexpectedly"),
      {
        code: ERR.EXITED,
        exitCode: exitInfo ? exitInfo.code : this.lastExitCode,
        signal: exitInfo ? exitInfo.signal : null,
      }
    );
    this.attempt = 0;
    const delayMs = Math.min(
      this.backoffMaxMs,
      this.backoffBaseMs * Math.pow(2, this.restartCount - 1)
    );
    this.setState(STATE.RETRYING);
    await this.sleep(delayMs);
    if (this.runToken !== token || this.generation !== newGeneration) {
      return;
    }
    await this._runCycle(token);
  }
}

module.exports = {
  BackendManager,
  STATE,
  ERR,
  DEFAULTS,
  isPortBusy,
  waitForHealth,
};

function runPackagingCli() {
  const { spawn } = require("child_process");
  const pyinstaller = spawn(
    "pyinstaller",
    [
      "-w",
      "--onefile",
      `--add-data web_app/app/templates${path.delimiter}templates`,
      `--add-data web_app/app/static${path.delimiter}static`,
      "--distpath",
      "dist-python",
      "web_app/run_app.py",
    ],
    {
      shell: true,
    }
  );

  pyinstaller.stdout.on("data", (data) => {
    console.log(data.toString());
  });

  pyinstaller.stderr.on("data", (data) => {
    console.log("Packaging error: " + data.toString());
  });

  pyinstaller.on("exit", (code) => {
    console.log("child process exited with code " + code.toString());
  });
}

if (require.main === module) {
  runPackagingCli();
}

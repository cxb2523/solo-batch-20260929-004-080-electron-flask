"use strict";

const { EventEmitter } = require("events");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const STATE = {
  IDLE: "idle",
  STARTING: "starting",
  READY: "ready",
  RETRYING: "retrying",
  FAILED: "failed",
};

class LaunchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LaunchError";
    this.exitCode = options.exitCode ?? null;
    if (options.code) this.code = options.code;
  }
}

class FlaskManagerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FlaskManagerError";
    this.code = code;
    Object.assign(this, details);
  }
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The supervisor lifecycle is also observable via "status" events, so a
  // rejection may have no awaiter (e.g. automatic recovery). Swallow the
  // unhandled-rejection warning here; callers of start()/restart() still
  // receive the rejection on the returned promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultCheckPortFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function defaultProbeOnce(host, port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve();
      else reject(new Error(`unexpected status ${res.statusCode}`));
    });
    req.on("timeout", () => req.destroy(new Error("probe request timed out")));
    req.on("error", reject);
  });
}

/**
 * Single source of truth for the Flask child-process lifecycle.
 *
 * States: idle -> starting -> ready -> (retrying -> ready)* -> failed.
 * The renderer is only told about a real baseURL once the health probe has
 * passed. Port collisions are retried on the next port with exponential
 * backoff, capped by maxRetries. An unexpected exit re-enters the supervisor
 * loop so the backend recovers instead of getting stuck.
 */
class FlaskManager extends EventEmitter {
  constructor(options = {}) {
    super();
    if (typeof options.spawnForAttempt !== "function") {
      throw new TypeError("FlaskManager requires a spawnForAttempt(attempt, port) function");
    }
    this._spawnForAttempt = options.spawnForAttempt;
    this.host = options.host || "127.0.0.1";
    this.basePort = options.basePort || 4040;
    this.maxRetries = options.maxRetries ?? 5;
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 10000;
    this.probePath = options.probePath || "/healthz";
    this.probeIntervalMs = options.probeIntervalMs ?? 150;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20000;
    this._sleep = options.sleep || defaultSleep;
    this._backoffSleep = options.backoffSleep || this._sleep;
    this._checkPortFree = options.checkPortFree || defaultCheckPortFree;
    this._probeOnce = options.probeOnce || defaultProbeOnce;
    this._spawn = options.spawnImpl || spawn;

    this.state = STATE.IDLE;
    this.attempt = 0;
    this.lastExitCode = null;
    this.lastError = null;
    this.baseURL = null;
    this.port = null;
    // Increments every time a new child process is spawned. Requests captured
    // against an older generation must never be dispatched to a new process.
    this.generation = 0;

    this._child = null;
    this._stopping = false;
    this._supervising = false;
    this._runId = 0;
    this._settled = null;
  }

  getStatus() {
    return {
      state: this.state,
      attempt: this.attempt,
      maxRetries: this.maxRetries,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      baseURL: this.baseURL,
      port: this.port,
      generation: this.generation,
    };
  }

  _emitStatus() {
    this.emit("status", this.getStatus());
  }

  /**
   * Single-flight: concurrent calls while a launch/probe is in progress
   * return the same promise instead of spawning competing supervisors.
   */
  start() {
    if (this._supervising && this._settled) return this._settled.promise;
    if (this.state === STATE.READY) return Promise.resolve(this.getStatus());
    this._stopping = false;
    this._settled = defer();
    this._superviseRun(false);
    return this._settled.promise;
  }

  restart() {
    this._stopping = false;
    this._runId += 1; // invalidate any in-flight supervisor loop
    this._killChild();
    this._supervising = false;
    this._settled = defer();
    this._superviseRun(true);
    return this._settled.promise;
  }

  async stop() {
    this._stopping = true;
    this._runId += 1;
    this._killChild();
    if (this._settled) {
      this._settled.reject(new FlaskManagerError("FLASK_STOPPED", "Flask manager stopped"));
    }
    this.state = STATE.IDLE;
    this.baseURL = null;
    this.port = null;
    this._emitStatus();
  }

  _killChild() {
    const child = this._child;
    this._child = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }

  _backoffDelay() {
    return Math.min(this.backoffBaseMs * 2 ** (this.attempt - 1), this.backoffMaxMs);
  }

  async _superviseRun(isRecovery) {
    if (this._supervising) return;
    this._supervising = true;
    const runId = ++this._runId;
    this.attempt = 0;
    try {
      while (!this._stopping && runId === this._runId) {
        this.attempt += 1;
        const port = this.basePort + this.attempt - 1;
        this.state = this.attempt === 1 && !isRecovery ? STATE.STARTING : STATE.RETRYING;
        this.port = port;
        this.baseURL = null;
        this._emitStatus();
        try {
          await this._tryLaunchOnce(port);
        } catch (err) {
          if (this._stopping || runId !== this._runId) return;
          this.lastError = err.message;
          if (err.exitCode !== null && err.exitCode !== undefined) {
            this.lastExitCode = err.exitCode;
          }
          if (this.attempt > this.maxRetries) {
            this.state = STATE.FAILED;
            this.baseURL = null;
            this._emitStatus();
            this._settled.reject(
              new FlaskManagerError(
                "FLASK_START_FAILED",
                `Flask backend failed after ${this.attempt} attempt(s): ${this.lastError}`,
                { exitCode: this.lastExitCode, attempts: this.attempt }
              )
            );
            return;
          }
          await this._backoffSleep(this._backoffDelay());
          continue;
        }
        if (this._stopping || runId !== this._runId) return;
        this.state = STATE.READY;
        this.baseURL = `http://${this.host}:${port}`;
        this.port = port;
        this.lastError = null;
        this._emitStatus();
        this._settled.resolve(this.getStatus());
        return;
      }
    } finally {
      if (runId === this._runId) this._supervising = false;
    }
  }

  async _tryLaunchOnce(port) {
    const free = await this._checkPortFree(port, this.host);
    if (!free) {
      throw new LaunchError(`Port ${port} is already in use`, { code: "EADDRINUSE" });
    }

    const spec = this._spawnForAttempt(this.attempt, port);
    const child = this._spawn(spec.command, spec.args || [], {
      env: spec.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.generation += 1;
    this._child = child;

    let stderrTail = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
    }
    if (child.stdout) child.stdout.on("data", () => {});

    let earlySettled = false;
    const earlyExit = new Promise((resolve) => {
      child.once("error", (err) => {
        if (!earlySettled) {
          earlySettled = true;
          resolve({ error: err });
        }
      });
      child.once("exit", (code, signal) => {
        if (!earlySettled) {
          earlySettled = true;
          resolve({ exitCode: code, signal });
        }
      });
    });

    const probeToken = { cancelled: false };
    const probed = this._probeUntilReady(port, probeToken).then(
      () => ({ type: "ready" }),
      (err) => ({ type: "probe-failed", error: err })
    );
    const outcome = await Promise.race([
      probed,
      earlyExit.then((result) => ({ type: "exit", ...result })),
    ]);

    if (outcome.type === "ready") {
      this._watchChild(child);
      return;
    }

    probeToken.cancelled = true;
    this._child = null;
    try {
      child.kill();
    } catch {
      // already gone
    }
    if (outcome.type === "exit") {
      if (outcome.error) {
        throw new LaunchError(`Failed to spawn Flask backend: ${outcome.error.message}`, {
          code: outcome.error.code,
        });
      }
      throw new LaunchError(
        `Flask backend exited during startup (code ${outcome.exitCode}). ${stderrTail}`.trim(),
        { exitCode: outcome.exitCode }
      );
    }
    throw new LaunchError(`Health probe failed on port ${port}: ${outcome.error.message}`);
  }

  async _probeUntilReady(port, token) {
    const deadline = Date.now() + this.probeTimeoutMs;
    let lastError = null;
    while (!token.cancelled && Date.now() < deadline) {
      try {
        await this._probeOnce(this.host, port, this.probePath, Math.min(1000, this.probeTimeoutMs));
        return;
      } catch (err) {
        lastError = err;
        await this._sleep(this.probeIntervalMs);
      }
    }
    if (token.cancelled) throw new LaunchError("probe cancelled");
    throw new LaunchError(`probe timed out (${lastError ? lastError.message : "no response"})`);
  }

  _watchChild(child) {
    child.once("exit", (code, signal) => this._handleChildExit(child, code, signal, null));
    child.once("error", (err) => this._handleChildExit(child, null, null, err));
  }

  _handleChildExit(child, exitCode, signal, error) {
    if (child !== this._child) return; // stale process from an older run
    this._child = null;
    if (this._stopping) return;
    this.lastExitCode = exitCode ?? (error ? -1 : null);
    this.lastError = error
      ? error.message
      : `Flask backend exited unexpectedly (code ${exitCode}${signal ? `, signal ${signal}` : ""})`;
    this.baseURL = null;
    this.state = STATE.RETRYING;
    this._emitStatus();
    // Recover instead of getting stuck: re-enter the supervisor loop.
    this._settled = defer();
    this._superviseRun(true);
  }
}

module.exports = { FlaskManager, FlaskManagerError, LaunchError, STATE };

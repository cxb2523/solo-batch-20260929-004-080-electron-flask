"use strict";

const ERROR_CODES = {
  FAILED: "FLASK_FAILED",
  RESTARTED: "FLASK_RESTARTED",
  QUEUE_TIMEOUT: "FLASK_QUEUE_TIMEOUT",
  REQUEST_TIMEOUT: "FLASK_REQUEST_TIMEOUT",
  NETWORK: "FLASK_NETWORK",
  BAD_JSON: "FLASK_BAD_JSON",
};

class FlaskClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FlaskClientError";
    this.code = code;
    Object.assign(this, details);
  }
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === "function") {
    const out = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return headers;
}

/**
 * Renderer-side client for the Flask backend.
 *
 * - Requests made before the backend is ready are held in a pending queue
 *   (bounded by queueTimeoutMs — nothing waits forever).
 * - When the backend crashes, queued and in-flight requests are rejected with
 *   FLASK_RESTARTED so stale requests never land on the respawned process.
 * - When the backend enters `failed`, everything is rejected with
 *   FLASK_FAILED carrying the last exit code.
 */
function createFlaskClient(options = {}) {
  const fetchImpl = options.fetchImpl || ((url, init) => fetch(url, init));
  const requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  const queueTimeoutMs = options.queueTimeoutMs ?? 30000;

  let status = options.initialStatus || {
    state: "starting",
    attempt: 0,
    maxRetries: 0,
    lastExitCode: null,
    lastError: null,
    baseURL: null,
  };
  const queue = [];
  const inflight = new Set();
  const listeners = new Set();

  function getStatus() {
    return status;
  }

  function onStatus(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function rejectQueue(error) {
    while (queue.length) {
      const entry = queue.shift();
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function abortInflight(error) {
    for (const entry of Array.from(inflight)) {
      entry.abortedBy = error;
      entry.controller.abort();
    }
  }

  function updateStatus(next) {
    const prev = status;
    status = next;
    const crashed =
      prev.state === "ready" && (next.state === "starting" || next.state === "retrying");
    if (crashed) {
      const error = new FlaskClientError(
        ERROR_CODES.RESTARTED,
        "Flask backend restarted; pending and in-flight requests were cancelled",
        { exitCode: next.lastExitCode ?? null, state: next.state }
      );
      rejectQueue(error);
      abortInflight(error);
    }
    if (next.state === "failed") {
      const error = new FlaskClientError(
        ERROR_CODES.FAILED,
        `Flask backend failed: ${next.lastError || "unknown error"}`,
        { exitCode: next.lastExitCode ?? null, state: next.state }
      );
      rejectQueue(error);
      abortInflight(error);
    }
    if (next.state === "ready" && prev.state !== "ready") {
      flushQueue(next);
    }
    for (const callback of listeners) {
      try {
        callback(next);
      } catch {
        // listener errors must not break status propagation
      }
    }
  }

  function flushQueue(readyStatus) {
    const pending = queue.splice(0, queue.length);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      dispatch(entry.path, entry.options, readyStatus.baseURL).then(entry.resolve, entry.reject);
    }
  }

  function enqueue(path, reqOptions) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = queue.findIndex((entry) => entry.timer === timer);
        if (index !== -1) queue.splice(index, 1);
        reject(
          new FlaskClientError(
            ERROR_CODES.QUEUE_TIMEOUT,
            `Timed out after ${queueTimeoutMs}ms waiting for the Flask backend`,
            { state: status.state }
          )
        );
      }, queueTimeoutMs);
      queue.push({ path, options: reqOptions, resolve, reject, timer });
    });
  }

  function dispatch(path, reqOptions, baseURL) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const entry = { controller, abortedBy: null };
      const timer = setTimeout(() => {
        entry.abortedBy = new FlaskClientError(
          ERROR_CODES.REQUEST_TIMEOUT,
          `Request to ${path} timed out after ${requestTimeoutMs}ms`
        );
        controller.abort();
      }, requestTimeoutMs);
      inflight.add(entry);
      Promise.resolve()
        .then(() => fetchImpl(baseURL + path, { ...reqOptions, signal: controller.signal }))
        .then(async (res) => {
          const body = await res.text();
          resolve({
            ok: res.ok,
            status: res.status,
            statusText: res.statusText || "",
            headers: normalizeHeaders(res.headers),
            body,
          });
        })
        .catch((err) => {
          if ((err && err.name === "AbortError") || entry.abortedBy) {
            reject(
              entry.abortedBy ||
                new FlaskClientError(ERROR_CODES.NETWORK, `Request to ${path} was aborted`)
            );
          } else {
            reject(
              new FlaskClientError(
                ERROR_CODES.NETWORK,
                `Request to ${path} failed: ${err && err.message}`
              )
            );
          }
        })
        .finally(() => {
          clearTimeout(timer);
          inflight.delete(entry);
        });
    });
  }

  function request(path, reqOptions = {}) {
    if (status.state === "failed") {
      return Promise.reject(
        new FlaskClientError(
          ERROR_CODES.FAILED,
          `Flask backend is failed: ${status.lastError || "unknown error"}`,
          { exitCode: status.lastExitCode ?? null, state: status.state }
        )
      );
    }
    if (status.state === "ready" && status.baseURL) {
      return dispatch(path, reqOptions, status.baseURL);
    }
    return enqueue(path, reqOptions);
  }

  async function requestJson(path, reqOptions = {}) {
    const res = await request(path, reqOptions);
    try {
      return JSON.parse(res.body);
    } catch (err) {
      throw new FlaskClientError(ERROR_CODES.BAD_JSON, `Invalid JSON from ${path}: ${err.message}`, {
        status: res.status,
      });
    }
  }

  return {
    request,
    requestJson,
    updateStatus,
    getStatus,
    onStatus,
    pendingCount: () => queue.length,
  };
}

module.exports = { createFlaskClient, FlaskClientError, ERROR_CODES };

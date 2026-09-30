"use strict";

/**
 * Renderer-side companion to the main-process BackendManager.
 *
 * - Requests issued before "ready" are parked in a pending queue; they never
 *   hit a dead address.
 * - When the backend enters "failed" every parked / in-flight request is
 *   rejected with the manager's error code, so nothing can hang forever.
 * - Every request is stamped with the generation of the process era it is
 *   allowed to talk to. After an unexpected exit the manager moves to a new
 *   generation and all old requests are rejected with ERR_BACKEND_RESTARTED,
 *   guaranteeing old requests never land on the restarted process.
 * - A per-request timeout is a final safety net against indefinite waiting.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function backendError(code, message, extra) {
  return Object.assign(new Error(message || code), { code }, extra || {});
}

class BackendClient {
  constructor(options) {
    const config = options || {};
    this.fetchImpl =
      config.fetch || (typeof fetch === "function" ? fetch : null);
    this.requestTimeoutMs =
      config.requestTimeoutMs != null
        ? config.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
    this.state = "starting";
    this.baseURL = null;
    this.generation = 0;
    this.restartCount = 0;
    this.attempt = 0;
    this.lastExitCode = null;
    this.lastError = null;
    this.queue = [];
    this.inflight = new Set();
    this.onStateChange = config.onStateChange || null;
    this.primed = false;
  }

  getStatus() {
    return {
      state: this.state,
      baseURL: this.baseURL,
      generation: this.generation,
      restartCount: this.restartCount,
      attempt: this.attempt,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      pending: this.queue.length,
    };
  }

  // Main process -> renderer. Snapshot shape is BackendManager#snapshot().
  handleState(snapshot) {
    if (!snapshot) {
      return;
    }
    const isFirstSnapshot = !this.primed;
    this.primed = true;
    const previousGeneration = this.generation;
    this.state = snapshot.state;
    this.baseURL = snapshot.baseURL;
    this.generation = snapshot.generation;
    this.restartCount = snapshot.restartCount;
    this.attempt = snapshot.attempt;
    this.lastExitCode = snapshot.lastExitCode;
    this.lastError = snapshot.lastError;

    if (this.state === "failed") {
      const error = this._failureError();
      this._rejectAllQueued(error);
      this._abortInflight(error);
    } else if (isFirstSnapshot && this.generation > 0) {
      // Requests queued before the first state broadcast had nowhere to
      // stamp their generation; adopt them into the current startup era
      // instead of rejecting them.
      this.queue.forEach((entry) => {
        if (entry.generation === 0) {
          entry.generation = this.generation;
        }
      });
    } else if (this.generation !== previousGeneration) {
      this._invalidateOlder(this.generation);
    }

    if (this.state === "ready" && this.baseURL) {
      this._flushQueue();
    }

    if (this.onStateChange) {
      this.onStateChange(this.getStatus());
    }
  }

  request(pathOrOptions, options) {
    const opts =
      typeof pathOrOptions === "string"
        ? Object.assign({}, options || {}, { path: pathOrOptions })
        : Object.assign({}, pathOrOptions || {});
    const generation = this.generation;

    if (this.state === "failed") {
      return Promise.reject(this._failureError());
    }

    const entry = {
      generation,
      path: opts.path || "/",
      options: opts,
      timer: null,
      settle: null,
    };
    const promise = new Promise((resolve, reject) => {
      entry.settle = { resolve, reject };
    });

    const timeoutMs =
      opts.timeoutMs != null ? opts.timeoutMs : this.requestTimeoutMs;
    entry.timer = setTimeout(() => {
      this._dropEntry(entry);
      entry.settle.reject(
        backendError(
          "ERR_BACKEND_TIMEOUT",
          "request timed out waiting for the backend"
        )
      );
    }, timeoutMs);

    if (this.state === "ready" && this.baseURL) {
      this._dispatch(entry);
    } else {
      this.queue.push(entry);
    }
    return promise;
  }

  _failureError() {
    const last = this.lastError || {};
    return backendError(
      last.code || "ERR_BACKEND_UNAVAILABLE",
      last.message || "backend is not available",
      {
        exitCode: this.lastExitCode,
        attempt: this.attempt,
        restartCount: this.restartCount,
      }
    );
  }

  _invalidateOlder(generation) {
    const error = backendError(
      "ERR_BACKEND_RESTARTED",
      "the backend process was restarted before the request could be served"
    );
    const staleQueued = this.queue.filter(
      (entry) => entry.generation < generation
    );
    staleQueued.forEach((entry) => {
      this._dropEntry(entry);
      entry.settle.reject(error);
    });
    this.queue = this.queue.filter((entry) => entry.generation >= generation);

    this.inflight.forEach((entry) => {
      if (entry.generation < generation && entry.controller) {
        entry.stale = true;
        entry.controller.abort();
      }
    });
  }

  _rejectAllQueued(error) {
    const queued = this.queue.slice();
    this.queue = [];
    queued.forEach((entry) => {
      this._dropEntry(entry);
      entry.settle.reject(error);
    });
  }

  _abortInflight(error) {
    this.inflight.forEach((entry) => {
      entry.forcedError = error;
      if (entry.controller) {
        entry.controller.abort();
      }
    });
  }

  _flushQueue() {
    const ready = this.queue.filter(
      (entry) => entry.generation === this.generation
    );
    this.queue = [];
    ready.forEach((entry) => this._dispatch(entry));
  }

  _dropEntry(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const index = this.queue.indexOf(entry);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  _dispatch(entry) {
    this._dropEntry(entry);
    if (entry.generation !== this.generation || !this.baseURL) {
      entry.settle.reject(
        backendError(
          "ERR_BACKEND_RESTARTED",
          "request was stamped for a backend generation that is no longer current"
        )
      );
      return;
    }

    if (!this.fetchImpl) {
      entry.settle.reject(
        backendError("ERR_NO_FETCH", "fetch is not available in this runtime")
      );
      return;
    }

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    entry.controller = controller;
    const timeoutMs =
      entry.options && entry.options.timeoutMs != null
        ? entry.options.timeoutMs
        : this.requestTimeoutMs;
    entry.timer = setTimeout(() => {
      if (controller) {
        controller.abort();
      }
      entry.timedOut = true;
    }, timeoutMs);
    this.inflight.add(entry);

    const url = this.baseURL.replace(/\/$/, "") + entry.path;
    const fetchOptions = Object.assign({}, entry.options || {});
    delete fetchOptions.path;
    delete fetchOptions.timeoutMs;
    if (controller) {
      fetchOptions.signal = controller.signal;
    }

    this.fetchImpl(url, fetchOptions)
      .then((response) => {
        if (entry.stale) {
          entry.settle.reject(
            backendError(
              "ERR_BACKEND_RESTARTED",
              "backend restarted while the request was in flight"
            )
          );
          return;
        }
        entry.settle.resolve(response);
      })
      .catch((error) => {
        if (entry.forcedError) {
          entry.settle.reject(entry.forcedError);
        } else if (entry.timedOut) {
          entry.settle.reject(
            backendError(
              "ERR_BACKEND_TIMEOUT",
              "request timed out waiting for a backend response"
            )
          );
        } else if (entry.stale || (controller && controller.signal.aborted)) {
          entry.settle.reject(
            backendError(
              "ERR_BACKEND_RESTARTED",
              "backend restarted while the request was in flight"
            )
          );
        } else {
          entry.settle.reject(
            backendError(
              "ERR_BACKEND_REQUEST_FAILED",
              error && error.message ? error.message : "request failed",
              { cause: error }
            )
          );
        }
      })
      .finally(() => {
        this.inflight.delete(entry);
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
      });
  }
}

module.exports = { BackendClient, backendError, DEFAULT_REQUEST_TIMEOUT_MS };

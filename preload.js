"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const { BackendClient } = require("./backend_client");

const client = new BackendClient({
  fetch: (...args) => fetch(...args),
});

let statusEl = null;
let frameEl = null;
let retryBtn = null;

const STATUS_LABELS = {
  starting: "后端启动中…",
  ready: "后端已就绪",
  retrying: "后端重试中…",
  failed: "后端启动失败",
};

function renderStatus(status) {
  if (!statusEl) {
    return;
  }
  const label = STATUS_LABELS[status.state] || status.state;
  const exitText =
    status.lastExitCode === null || status.lastExitCode === undefined
      ? "-"
      : String(status.lastExitCode);
  const errorText =
    status.lastError && status.lastError.code
      ? " " + status.lastError.code
      : "";
  statusEl.textContent =
    label +
    " | 尝试 " +
    status.attempt +
    " 次 | 已重启 " +
    status.restartCount +
    " 次 | 最近退出码 " +
    exitText +
    errorText;
  statusEl.dataset.state = status.state;
  if (retryBtn) {
    retryBtn.style.display = status.state === "failed" ? "" : "none";
  }
}

function showAppFrame(baseURL) {
  if (!frameEl || !baseURL) {
    return;
  }
  if (frameEl.src !== baseURL + "/") {
    frameEl.src = baseURL + "/";
  }
  frameEl.style.display = "";
}

function hideAppFrame() {
  if (frameEl) {
    frameEl.style.display = "none";
    frameEl.src = "about:blank";
  }
}

function mountStatusBar() {
  statusEl = document.getElementById("backend-status-text");
  frameEl = document.getElementById("backend-frame");
  retryBtn = document.getElementById("backend-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      ipcRenderer.send("backend:retry");
    });
  }
  client.onStateChange = (status) => {
    renderStatus(status);
    if (status.state === "ready" && status.baseURL) {
      showAppFrame(status.baseURL);
    } else if (status.state === "failed") {
      hideAppFrame();
    }
  };
  renderStatus(client.getStatus());
}

ipcRenderer.on("backend:state", (_event, snapshot) => {
  client.handleState(snapshot);
});

contextBridge.exposeInMainWorld("backend", {
  request: (requestPath, options) => client.request(requestPath, options),
  getStatus: () => client.getStatus(),
  retry: () => ipcRenderer.send("backend:retry"),
});

window.addEventListener("DOMContentLoaded", mountStatusBar);

ipcRenderer
  .invoke("backend:get-state")
  .then((snapshot) => {
    if (snapshot) {
      client.handleState(snapshot);
    }
  })
  .catch(() => {
    // main process not responding; leave the bar in its starting state
  });

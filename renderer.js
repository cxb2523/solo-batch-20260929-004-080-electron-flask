"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawn, execFile } = require("child_process");
const {
  BackendManager,
  STATE,
  DEFAULTS,
} = require("./package_python");

// Keep a global reference of the window object, otherwise the window is
// closed automatically when the JavaScript object is garbage collected.
let mainWindow = null;
let backend = null;

const PY_DIST_FOLDER = "dist-python";
const PY_SRC_FOLDER = "web_app";
const PY_MODULE = "run_app.py";
const BACKEND_PORT = Number(process.env.BACKEND_PORT) || DEFAULTS.port;

const isRunningInBundle = () =>
  require("fs").existsSync(path.join(__dirname, PY_DIST_FOLDER));

const getPythonScriptPath = () => {
  if (!isRunningInBundle()) {
    return path.join(__dirname, PY_SRC_FOLDER, PY_MODULE);
  }
  if (process.platform === "win32") {
    return path.join(
      __dirname,
      PY_DIST_FOLDER,
      PY_MODULE.slice(0, -3) + ".exe"
    );
  }
  return path.join(__dirname, PY_DIST_FOLDER, PY_MODULE);
};

const startPythonSubprocess = ({ host, port }) => {
  const script = getPythonScriptPath();
  const env = Object.assign({}, process.env, {
    FLASK_HOST: host,
    FLASK_PORT: String(port),
  });
  if (isRunningInBundle()) {
    return execFile(script, [], { env });
  }
  return spawn("python", [script], { env });
};

const broadcastState = (snapshot) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("backend:state", snapshot);
  }
};

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: path.join(__dirname, "icon.png"),
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the local shell. The real Flask baseURL is only loaded into the
  // embedded frame after the manager has probed it as ready.
  mainWindow.loadFile(path.join(__dirname, "loading.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const initBackend = () => {
  if (backend) {
    return backend;
  }
  backend = new BackendManager({
    host: DEFAULTS.host,
    port: BACKEND_PORT,
    launchChild: startPythonSubprocess,
  });
  backend.on("state", broadcastState);
  return backend;
};

ipcMain.handle("backend:get-state", () => {
  return backend ? backend.snapshot() : null;
});

ipcMain.on("backend:retry", () => {
  if (!backend) {
    initBackend();
  }
  if (backend.state === STATE.FAILED) {
    backend.start();
  }
});

app.on("ready", () => {
  initBackend();
  createMainWindow();
  backend.start();
});

app.on("browser-window-created", (_event, window) => {
  window.setMenu(null);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    const shutdown = backend
      ? backend.stop()
      : Promise.resolve();
    shutdown.then(() => app.quit());
  }
});

app.on("activate", () => {
  initBackend();
  if (mainWindow === null) {
    createMainWindow();
  }
  if (backend.state !== STATE.READY) {
    backend.start();
  }
});

app.on("before-quit", () => {
  if (backend) {
    backend.stop();
  }
});

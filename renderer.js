"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { FlaskManager } = require("./main/flask_manager");

// Keep a global reference of the mainWindow object, if you don't, the mainWindow will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow = null;

const PY_DIST_FOLDER = "dist-python"; // python distributable folder
const PY_SRC_FOLDER = "web_app"; // path to the python source
const PY_MODULE = "run_app.py"; // the name of the main module
const FLASK_BASE_PORT = 4040;

const isRunningInBundle = () => {
  return require("fs").existsSync(path.join(__dirname, PY_DIST_FOLDER));
};

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

// Single state machine for the Flask child process. It probes the port
// before declaring readiness and broadcasts the real baseURL to renderers.
const flaskManager = new FlaskManager({
  basePort: FLASK_BASE_PORT,
  maxRetries: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 8000,
  probePath: "/healthz",
  spawnForAttempt: (attempt, port) => {
    const env = { ...process.env, FLASK_PORT: String(port) };
    if (isRunningInBundle()) {
      return { command: getPythonScriptPath(), args: [], env };
    }
    return { command: "python", args: [getPythonScriptPath()], env };
  },
});

const broadcastStatus = (status) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("flask:status", status);
  }
};

flaskManager.on("status", (status) => {
  broadcastStatus(status);
  if (status.state === "ready" && mainWindow && !mainWindow.isDestroyed()) {
    const currentURL = mainWindow.webContents.getURL();
    if (!currentURL.startsWith(status.baseURL)) {
      mainWindow.loadURL(`${status.baseURL}/`);
    }
  }
});

ipcMain.handle("flask:get-status", () => flaskManager.getStatus());
ipcMain.handle("flask:restart", () => flaskManager.restart());

// Safety net for stray python descendants (e.g. flask reloader children)
// that outlive the direct child process.
const killLeftoverPythonProcesses = () => {
  const psTree = require("ps-tree");
  const pythonScriptName = path.basename(getPythonScriptPath());
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    psTree(process.pid, (err, children) => {
      clearTimeout(timer);
      if (err) return resolve();
      children
        .filter((el) => el.COMMAND === pythonScriptName)
        .forEach((p) => {
          try {
            process.kill(p.PID);
          } catch {
            // already gone
          }
        });
      resolve();
    });
  });
};

const createMainWindow = () => {
  // Create the browser mainWindow
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    // transparent: true, // transparent header bar
    icon: __dirname + "/icon.png",
    // fullscreen: true,
    // opacity:0.8,
    // darkTheme: true,
    // frame: false,
    resizeable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  // Only load the Flask app once the manager has probed a real baseURL;
  // until then show a local loading page with the status bar.
  const status = flaskManager.getStatus();
  if (status.state === "ready" && status.baseURL) {
    mainWindow.loadURL(`${status.baseURL}/`);
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer", "loading.html"));
  }

  // Open the DevTools.
  //mainWindow.webContents.openDevTools();

  // Emitted when the mainWindow is closed.
  mainWindow.on("closed", function () {
    // Dereference the mainWindow object
    mainWindow = null;
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", function () {
  createMainWindow();
  flaskManager.start().catch((err) => {
    console.error("Flask backend failed to start:", err.message);
  });
});

// disable menu
app.on("browser-window-created", function (e, window) {
  window.setMenu(null);
});

// Quit when all windows are closed.
app.on("window-all-closed", () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== "darwin") {
    flaskManager
      .stop()
      .then(killLeftoverPythonProcesses)
      .then(() => {
        app.quit();
      });
  }
});

app.on("activate", () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createMainWindow();
  }
  flaskManager.start().catch(() => {});
});

app.on("quit", function () {
  // do some additional cleanup
});

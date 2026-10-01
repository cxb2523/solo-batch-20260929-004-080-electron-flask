"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const { createFlaskClient } = require("./renderer/flask_client");
const { createStatusBar } = require("./renderer/status_bar");

const client = createFlaskClient();

ipcRenderer.on("flask:status", (_event, status) => client.updateStatus(status));
ipcRenderer.invoke("flask:get-status").then((status) => {
  if (status) client.updateStatus(status);
});

contextBridge.exposeInMainWorld("flask", {
  request: (path, options) => client.request(path, options),
  requestJson: (path, options) => client.requestJson(path, options),
  getStatus: () => client.getStatus(),
  onStatus: (callback) => client.onStatus(callback),
  restart: () => ipcRenderer.invoke("flask:restart"),
});

window.addEventListener("DOMContentLoaded", () => {
  const bar = createStatusBar(document);
  client.onStatus((status) => bar.update(status));
  bar.update(client.getStatus());
});

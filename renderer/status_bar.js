"use strict";

const STATE_COLORS = {
  idle: "#616161",
  starting: "#b58900",
  retrying: "#cb4b16",
  ready: "#2e7d32",
  failed: "#c62828",
};

/**
 * Fixed status bar injected into every loaded page. Shows the backend state,
 * retry counter and the most recent exit code so failures are visible
 * instead of hanging silently.
 */
function createStatusBar(doc) {
  const el = doc.createElement("div");
  el.id = "flask-status-bar";
  el.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:99999;" +
    "padding:4px 10px;font:12px/1.4 monospace;color:#fff;background:#616161;";
  (doc.body || doc.documentElement).appendChild(el);

  function update(status) {
    const exitCode =
      status.lastExitCode === null || status.lastExitCode === undefined
        ? "-"
        : status.lastExitCode;
    let text =
      `Flask: ${status.state} · retries ${status.attempt}/${status.maxRetries}` +
      ` · last exit code: ${exitCode}`;
    if (status.baseURL) text += ` · ${status.baseURL}`;
    if (status.lastError) text += ` · ${status.lastError}`;
    el.textContent = text;
    el.style.background = STATE_COLORS[status.state] || STATE_COLORS.idle;
    el.setAttribute("data-state", status.state);
  }

  return { update, element: el };
}

module.exports = { createStatusBar };

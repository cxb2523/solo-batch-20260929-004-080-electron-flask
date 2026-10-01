"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createStatusBar } = require("../renderer/status_bar");

function fakeDocument() {
  const el = {
    id: "",
    style: {},
    textContent: "",
    attrs: {},
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
  };
  return {
    el,
    doc: {
      createElement: () => el,
      body: { appendChild() {} },
    },
  };
}

test("status bar shows state, retry count and last exit code", () => {
  const { el, doc } = fakeDocument();
  const bar = createStatusBar(doc);

  bar.update({ state: "retrying", attempt: 2, maxRetries: 5, lastExitCode: 1, baseURL: null, lastError: "boom" });
  assert.match(el.textContent, /retrying/);
  assert.match(el.textContent, /2\/5/);
  assert.match(el.textContent, /last exit code: 1/);
  assert.match(el.textContent, /boom/);
  assert.strictEqual(el.attrs["data-state"], "retrying");

  bar.update({ state: "ready", attempt: 1, maxRetries: 5, lastExitCode: null, baseURL: "http://127.0.0.1:4041", lastError: null });
  assert.match(el.textContent, /ready/);
  assert.match(el.textContent, /last exit code: -/);
  assert.match(el.textContent, /http:\/\/127\.0\.0\.1:4041/);
});

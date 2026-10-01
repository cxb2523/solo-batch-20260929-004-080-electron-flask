"use strict";

const path = require("path");
const { spawn } = require("child_process");

const child = spawn(
  "pyinstaller",
  [
    "-w",
    "--onefile",
    `--add-data web_app/app/templates${path.delimiter}templates`,
    `--add-data web_app/app/static${path.delimiter}static`,
    "--distpath dist-python",
    "web_app/run_app.py",
  ],
  {
    shell: true,
    stdio: "inherit",
  }
);

child.on("error", (err) => {
  console.error("Failed to start pyinstaller: " + err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code === 0) {
    console.log("Python packaging completed successfully.");
    return;
  }
  // Propagate the failure so `npm run package` actually fails instead of
  // continuing with a missing or stale dist-python bundle.
  console.error(`Packaging failed (exit code ${code === null ? signal : code}).`);
  process.exit(code === null ? 1 : code);
});

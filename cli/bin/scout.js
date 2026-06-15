#!/usr/bin/env node

// scoutpost-cli launcher.
//
// `npm i -g scoutpost-cli` puts this file on PATH as `scout` (via the package's
// `bin` field). It locates the native `deno compile` binary for the current
// platform — downloaded into this same `bin/` dir by scripts/postinstall.js —
// and execs it, proxying argv, stdio, exit code, and signals. This mirrors the
// in-house dev-browser precedent, minus its Windows and musl branches (scout
// does not build those targets).

import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTargetAsset, SUPPORTED_PLATFORMS } from "../scripts/platform.js";

const here = dirname(fileURLToPath(import.meta.url));

function ensureExecutable(binaryPath) {
  try {
    accessSync(binaryPath, constants.X_OK);
    return;
  } catch {
    // Not executable yet — try to add the bit below.
  }
  try {
    chmodSync(binaryPath, 0o755);
  } catch (error) {
    console.error(`scout: cannot make the native binary executable: ${error.message}`);
    process.exit(1);
  }
}

function main() {
  const asset = getTargetAsset(platform(), arch());

  if (!asset) {
    console.error(`scout: unsupported platform ${platform()}-${arch()}`);
    console.error(`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}`);
    process.exit(1);
  }

  const binaryPath = join(here, asset);

  if (!existsSync(binaryPath)) {
    console.error(`scout: native binary not found for ${platform()}-${arch()}`);
    console.error(`Expected: ${binaryPath}`);
    console.error("");
    console.error("The postinstall step downloads this binary from GitHub releases.");
    console.error("Reinstall scoutpost-cli to retry the download:");
    console.error("  npm i -g scoutpost-cli");
    process.exit(1);
  }

  ensureExecutable(binaryPath);

  const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });

  child.on("error", (error) => {
    console.error(`scout: failed to launch native binary: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise the signal so the parent's exit status reflects how the child
      // actually died (e.g. SIGINT from Ctrl-C).
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main();

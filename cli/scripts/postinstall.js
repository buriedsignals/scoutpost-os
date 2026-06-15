#!/usr/bin/env node

// scoutpost-cli postinstall.
//
// On `npm install`, download the single native `scout` binary for the current
// platform from the public GitHub release into `bin/`, where bin/scout.js (the
// launcher) execs it. Binaries are NOT bundled in the npm tarball — they are
// downloaded here, exactly like the in-house dev-browser precedent.
//
// In a packaged npm install a failed/unsupported download HARD-FAILS the
// install (the package is useless without its binary). In a local repo checkout
// (a `.git` dir is present) it only warns, so contributors can `npm install`
// without a network fetch.

import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { get } from "node:https";
import { arch, platform } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getTargetAsset, SUPPORTED_PLATFORMS } from "./platform.js";
import { buildDownloadUrl } from "./release.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const binDir = join(projectRoot, "bin");
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
);
const version = packageJson.version;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

// A packaged npm install lives under a `node_modules` directory (global or
// project-local); a source checkout (cli/ in the monorepo or the OSS mirror)
// does not. Only hard-fail in the packaged case — the package is useless without
// its binary there — but let a contributor `npm install` from source offline.
// (Checking for a sibling `.git` would be wrong: the git dir is at the repo
// root, not inside cli/.)
function isPackagedInstall() {
  return projectRoot.split(sep).includes("node_modules");
}

function failOrWarn(message) {
  if (isPackagedInstall()) {
    throw new Error(message);
  }
  console.warn(`Warning: ${message}`);
  console.warn(
    "Continuing — this looks like a local checkout, not a packaged npm install.",
  );
}

// Best-effort: a chmod failure (read-only/noexec mount, foreign ownership)
// should not abort the install — the launcher surfaces a clear error at run
// time, and a genuine download failure is what hard-fails a packaged install.
function ensureExecutable(binaryPath) {
  try {
    chmodSync(binaryPath, 0o755);
  } catch (error) {
    console.warn(
      `Warning: could not mark ${binaryPath} executable: ${formatError(error)}`,
    );
  }
}

function downloadFile(url, destination) {
  const tempPath = `${destination}.download`;
  rmSync(tempPath, { force: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const request = (currentUrl, redirectsRemaining) => {
      const req = get(
        currentUrl,
        {
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": `scoutpost-cli/${version}`,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;

          // Follow GitHub -> object-store redirects.
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (redirectsRemaining === 0) {
              rejectOnce(new Error(`Too many redirects while downloading ${url}`));
              return;
            }
            request(
              new URL(response.headers.location, currentUrl),
              redirectsRemaining - 1,
            );
            return;
          }

          if (status !== 200) {
            response.resume();
            rejectOnce(new Error(`HTTP ${status || "unknown"} from ${currentUrl}`));
            return;
          }

          const file = createWriteStream(tempPath);
          const onError = (error) =>
            rejectOnce(new Error(`${currentUrl}: ${formatError(error)}`));
          file.on("error", onError);
          response.on("error", onError);
          response.on("aborted", () =>
            rejectOnce(new Error(`Download aborted for ${currentUrl}`)));
          response.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              try {
                renameSync(tempPath, destination);
                resolveOnce();
              } catch (error) {
                rejectOnce(error);
              }
            });
          });
        },
      );

      req.on("error", (error) =>
        rejectOnce(new Error(`${currentUrl}: ${formatError(error)}`)));
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`Request timed out after 30s for ${currentUrl}`));
      });
    };

    request(url, MAX_REDIRECTS);
  }).catch((error) => {
    rmSync(tempPath, { force: true });
    throw error;
  });
}

async function main() {
  const asset = getTargetAsset(platform(), arch());

  if (!asset) {
    failOrWarn(
      `Unsupported platform for scoutpost-cli: ${platform()}-${arch()}.\n` +
        `Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}.`,
    );
    return;
  }

  const binaryPath = join(binDir, asset);
  mkdirSync(binDir, { recursive: true });

  if (existsSync(binaryPath)) {
    ensureExecutable(binaryPath);
    console.log(`scoutpost-cli: native binary already present (${asset}).`);
    return;
  }

  const downloadUrl = buildDownloadUrl(asset, version);
  console.log(`scoutpost-cli: downloading ${asset} for ${platform()}-${arch()}...`);
  console.log(`  ${downloadUrl}`);

  try {
    await downloadFile(downloadUrl, binaryPath);
    ensureExecutable(binaryPath);
    console.log(`scoutpost-cli: installed native binary (${asset}).`);
  } catch (error) {
    failOrWarn(
      `Could not download native binary "${asset}" for ${platform()}-${arch()}.\n` +
        `  Tried: ${downloadUrl}\n` +
        `  Cause: ${formatError(error)}\n` +
        "scoutpost-cli cannot run without the native binary.",
    );
  }
}

// Run only when executed directly (`node scripts/postinstall.js`), never on
// import — so tests can import the pure helpers without triggering a download.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Error: scoutpost-cli postinstall failed: ${formatError(error)}`);
    process.exitCode = 1;
  });
}

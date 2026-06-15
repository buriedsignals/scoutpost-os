// Shared platform -> release-asset mapping for the scoutpost-cli npm package.
//
// Imported by BOTH bin/scout.js (the launcher) and scripts/postinstall.js (the
// downloader) so the binary the postinstall fetches is guaranteed to be the one
// the launcher looks for. Keeping this in one place prevents the asset-name
// drift bug that duplicated copies invite.
//
// The four asset names MUST match the binaries attached to the public release
// (buriedsignals/scoutpost-os -> scout-v<version>), which come from
// `deno task compile-all` in cli/deno.json:
//   scout-darwin-arm64, scout-darwin-x86_64, scout-linux-arm64, scout-linux-x86_64
//
// scout does not `deno compile` Windows or linux-musl (Alpine) targets, so those
// platforms intentionally map to null (unsupported).
//
// This module is intentionally PURE — it takes platform/arch strings and returns
// an asset name, with no `node:` imports. Host detection (os.platform()/arch())
// lives in the Node-only callers (bin/scout.js, scripts/postinstall.js). Keeping
// node builtins out of here lets the Deno test suite typecheck it without
// pulling @types/node (cli/ hosts both a Deno project and this npm package).

const TARGETS = Object.freeze({
  "darwin-arm64": "scout-darwin-arm64",
  "darwin-x86_64": "scout-darwin-x86_64",
  "linux-arm64": "scout-linux-arm64",
  "linux-x86_64": "scout-linux-x86_64",
});

/** Canonicalize a Node `os.arch()` value to the asset suffix, or null. */
export function normalizeArch(value) {
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x64" || value === "x86_64") return "x86_64";
  return null;
}

/**
 * `${platform}-${arch}` key into TARGETS, or null for unsupported combos.
 * @param {string} platform os.platform() value (e.g. "darwin", "linux")
 * @param {string} arch os.arch() value (e.g. "arm64", "x64")
 */
export function getTargetKey(platform, arch) {
  if (platform !== "darwin" && platform !== "linux") return null;
  const normalizedArch = normalizeArch(arch);
  if (!normalizedArch) return null;
  return `${platform}-${normalizedArch}`;
}

/**
 * Release asset name for the given platform/arch, or null if unsupported.
 * @param {string} platform os.platform() value (e.g. "darwin", "linux")
 * @param {string} arch os.arch() value (e.g. "arm64", "x64")
 */
export function getTargetAsset(platform, arch) {
  const key = getTargetKey(platform, arch);
  return key ? TARGETS[key] : null;
}

/** The four supported `${platform}-${arch}` keys, for error messages. */
export const SUPPORTED_PLATFORMS = Object.freeze(Object.keys(TARGETS));

/** The four real release asset names, for error messages and tests. */
export const SUPPORTED_ASSETS = Object.freeze(Object.values(TARGETS));

// Public release coordinates for scoutpost-cli binary downloads.
//
// The native binaries are attached to the PUBLIC mirror's GitHub releases:
//   https://github.com/buriedsignals/scoutpost-os/releases
// under tags of the form `scout-v<version>` (e.g. scout-v0.1.0). The release
// workflow (.github/workflows/cli-release.yml) publishes the four
// `deno compile` binaries there from a private `cli-v<version>` git tag.
//
// Keep REPO_SLUG and RELEASE_TAG_PREFIX in sync with that workflow's release
// job — a mismatch makes every `npm install` 404 on the binary download.

export const REPO_SLUG = "buriedsignals/scoutpost-os";
export const RELEASE_TAG_PREFIX = "scout-v";

/**
 * GitHub release download URL for an asset at a given package version.
 * @param {string} asset release asset name (e.g. "scout-darwin-arm64")
 * @param {string} version package version (e.g. "0.1.0")
 */
export function buildDownloadUrl(asset, version) {
  const tag = `${RELEASE_TAG_PREFIX}${version}`;
  return `https://github.com/${REPO_SLUG}/releases/download/${tag}/${asset}`;
}

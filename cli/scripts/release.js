// Public release coordinates for scoutpost-cli binary downloads.
//
// The native binaries are attached to the PUBLIC mirror's GitHub releases:
//   https://github.com/buriedsignals/scoutpost-os/releases
// under tags of the form `scout-v<version>` (e.g. scout-v0.1.0). The release
// workflow (.github/workflows/cli-release.yml) publishes the five
// `deno compile` binaries there from a private `cli-v<version>` git tag.
//
// Keep REPO_SLUG and RELEASE_TAG_PREFIX in sync with that workflow's release
// job — a mismatch makes every `npm install` 404 on the binary download.

export const REPO_SLUG = "buriedsignals/scoutpost-os";
export const RELEASE_TAG_PREFIX = "scout-v";
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

export function validateChecksumManifest(
  raw,
  expectedVersion,
  asset,
  requirePublisher = false,
) {
  if (
    !raw || raw.schema_version !== "scoutpost-binary-checksums/v1" ||
    raw.version !== expectedVersion
  ) {
    throw new Error(
      "The package checksum manifest does not match this version",
    );
  }
  const digest = raw.assets?.[asset];
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(
      `The package checksum manifest does not authorize ${asset}`,
    );
  }
  const publisherSubject = raw.publisher_subject;
  if (
    requirePublisher &&
    (typeof publisherSubject !== "string" || !publisherSubject.trim())
  ) {
    throw new Error(
      "The package checksum manifest is missing the approved Windows publisher",
    );
  }
  return { digest, publisherSubject };
}

export function validateDownloadURL(raw) {
  const parsed = raw instanceof URL ? raw : new URL(raw);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.port || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)
  ) {
    throw new Error(
      `Refusing unapproved binary download URL: ${parsed.origin}`,
    );
  }
  return parsed;
}

/**
 * GitHub release download URL for an asset at a given package version.
 * @param {string} asset release asset name (e.g. "scout-darwin-arm64")
 * @param {string} version package version (e.g. "0.1.0")
 */
export function buildDownloadUrl(asset, version) {
  const tag = `${RELEASE_TAG_PREFIX}${version}`;
  return `https://github.com/${REPO_SLUG}/releases/download/${tag}/${asset}`;
}

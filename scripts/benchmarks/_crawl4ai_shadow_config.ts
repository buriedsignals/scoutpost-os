const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CONTAINER_NAME_RE = /^scoutpost-scrape-[a-zA-Z0-9][a-zA-Z0-9_.-]{0,109}$/;
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;

export function validateLoopbackServiceOrigin(
  label: string,
  value: string,
): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} URL must be a credential-free loopback HTTP origin`,
    );
  }
  return url.origin;
}

export function validateContainerName(label: string, value: string): string {
  if (!CONTAINER_NAME_RE.test(value)) {
    throw new Error(
      `${label} container name must use the scoutpost-scrape- prefix`,
    );
  }
  return value;
}

export function validateImageId(label: string, value: string): string {
  if (!IMAGE_ID_RE.test(value)) {
    throw new Error(`${label} image must be an immutable sha256 image ID`);
  }
  return value;
}

export function validateDistinctContainers(
  control: string,
  candidate: string,
): void {
  if (control === candidate) {
    throw new Error("control and candidate containers must be different");
  }
}

export function validateDistinctImages(
  control: string,
  candidate: string,
): void {
  if (control === candidate) {
    throw new Error("control and candidate images must be different");
  }
}

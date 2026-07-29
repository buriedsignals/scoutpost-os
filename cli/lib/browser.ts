export interface BrowserEnvironment {
  os: string;
  ssh: boolean;
  graphical: boolean;
}

export function detectBrowserEnvironment(): BrowserEnvironment {
  const os = Deno.build.os;
  const ssh = Boolean(
    Deno.env.get("SSH_CONNECTION") || Deno.env.get("SSH_TTY") ||
      Deno.env.get("SSH_CLIENT"),
  );
  const graphical = os === "darwin" ||
    Boolean(Deno.env.get("DISPLAY") || Deno.env.get("WAYLAND_DISPLAY"));
  return { os, ssh, graphical };
}

export function browserCommand(
  url: string,
  environment = detectBrowserEnvironment(),
): { command: string; args: string[] } | null {
  if (environment.ssh || !environment.graphical) return null;
  if (environment.os === "darwin") {
    return { command: "/usr/bin/open", args: [url] };
  }
  if (environment.os === "linux") {
    return { command: "/usr/bin/xdg-open", args: [url] };
  }
  return null;
}

interface BrowserChild {
  status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): void;
}

export async function waitForBrowserProcess(
  child: BrowserChild,
  timeoutMs = 5_000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited between the status race and kill.
      }
      resolve(null);
    }, timeoutMs);
  });
  try {
    const status = await Promise.race([child.status, timeout]);
    return status?.success ?? false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function launchBrowser(url: string): Promise<boolean> {
  const command = browserCommand(url);
  if (!command) return false;
  try {
    const child = new Deno.Command(command.command, {
      args: command.args,
      stdout: "null",
      stderr: "null",
    }).spawn();
    return await waitForBrowserProcess(child);
  } catch {
    return false;
  }
}

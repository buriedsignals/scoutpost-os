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
  const graphical = os === "darwin" || os === "windows" ||
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

function windowsWide(value: string): Uint16Array<ArrayBuffer> {
  const encoded = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++) {
    encoded[index] = value.charCodeAt(index);
  }
  return encoded;
}

function launchWindowsBrowser(url: string): boolean {
  if (Deno.build.os !== "windows" || Deno.build.arch !== "x86_64") return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return false;
  }
  const shell = Deno.dlopen(
    "Shell32.dll",
    {
      ShellExecuteW: {
        parameters: [
          "pointer",
          "buffer",
          "buffer",
          "pointer",
          "pointer",
          "i32",
        ],
        result: "pointer",
      },
    } as const,
  );
  const operation = windowsWide("open");
  const target = windowsWide(parsed.href);
  try {
    const result = shell.symbols.ShellExecuteW(
      null,
      operation,
      target,
      null,
      null,
      1,
    );
    return Boolean(result && Deno.UnsafePointer.value(result) > 32n);
  } finally {
    shell.close();
  }
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
  if (Deno.build.os === "windows") {
    try {
      return launchWindowsBrowser(url);
    } catch {
      return false;
    }
  }
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

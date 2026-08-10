// Windows Credential Manager adapter for the compiled x86_64 `scout` CLI.
// Secret bytes never cross argv, stdout, or config.json. The Win32 Credential
// API encrypts generic credentials for the current Windows user.

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
const ERROR_NOT_FOUND = 1168;
const CREDENTIAL_SIZE_X64 = 80;

type AdvapiLibrary = ReturnType<typeof openAdvapi>;
type KernelLibrary = ReturnType<typeof openKernel>;

function wide(value: string): Uint16Array<ArrayBuffer> {
  const encoded = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++) {
    encoded[index] = value.charCodeAt(index);
  }
  return encoded;
}

function pointerValue(buffer: ArrayBufferView<ArrayBuffer>): bigint {
  const pointer = Deno.UnsafePointer.of(buffer);
  if (!pointer) {
    throw new Error("Windows credential buffer has no native pointer");
  }
  return Deno.UnsafePointer.value(pointer);
}

function openAdvapi() {
  return Deno.dlopen(
    "Advapi32.dll",
    {
      CredWriteW: { parameters: ["buffer", "u32"], result: "bool" },
      CredReadW: {
        parameters: ["buffer", "u32", "u32", "buffer"],
        result: "bool",
      },
      CredDeleteW: {
        parameters: ["buffer", "u32", "u32"],
        result: "bool",
      },
      CredFree: { parameters: ["pointer"], result: "void" },
    } as const,
  );
}

function openKernel() {
  return Deno.dlopen(
    "Kernel32.dll",
    {
      GetLastError: { parameters: [], result: "u32" },
    } as const,
  );
}

function assertWindowsX64(): void {
  if (Deno.build.os !== "windows" || Deno.build.arch !== "x86_64") {
    throw new Error(
      "Windows Credential Manager is supported only by the Windows x86_64 scout build",
    );
  }
}

function withLibraries<T>(
  fn: (advapi: AdvapiLibrary, kernel: KernelLibrary) => T,
): T {
  assertWindowsX64();
  const advapi = openAdvapi();
  const kernel = openKernel();
  try {
    return fn(advapi, kernel);
  } finally {
    kernel.close();
    advapi.close();
  }
}

/** A minimal current-user generic-credential store. */
export class WindowsCredentialStore {
  constructor(private readonly targetPrefix = "IndicatorLabs/Scoutpost") {}

  private target(key: string): Uint16Array<ArrayBuffer> {
    if (!/^[a-z_]{1,32}$/.test(key)) {
      throw new Error("Invalid Windows credential key name");
    }
    return wide(`${this.targetPrefix}/${key}`);
  }

  get(key: string): string | undefined {
    const target = this.target(key);
    return withLibraries((advapi, kernel) => {
      const output = new BigUint64Array(1);
      if (!advapi.symbols.CredReadW(target, CRED_TYPE_GENERIC, 0, output)) {
        const code = kernel.symbols.GetLastError();
        if (code === ERROR_NOT_FOUND) return undefined;
        throw new Error(`Windows Credential Manager read failed (${code})`);
      }
      const credentialPointer = Deno.UnsafePointer.create(output[0]);
      if (!credentialPointer) {
        throw new Error(
          "Windows Credential Manager returned an invalid credential pointer",
        );
      }
      try {
        const credential = new Deno.UnsafePointerView(credentialPointer);
        const byteLength = credential.getUint32(32);
        const blobPointer = credential.getPointer(40);
        if (byteLength === 0 || !blobPointer) return "";
        const bytes = new Uint8Array(
          new Deno.UnsafePointerView(blobPointer).getArrayBuffer(byteLength),
        );
        return new TextDecoder().decode(bytes.slice());
      } finally {
        advapi.symbols.CredFree(credentialPointer);
      }
    });
  }

  set(key: string, value: string): void {
    if (!value) {
      throw new Error("Refusing to store an empty Windows credential");
    }
    const target = this.target(key);
    const userName = wide("Indicator Labs");
    const blob = new TextEncoder().encode(value);
    if (blob.byteLength > 2_560) {
      throw new Error(
        "Windows credential exceeds the generic-credential size limit",
      );
    }
    withLibraries((advapi, kernel) => {
      const structure = new Uint8Array(CREDENTIAL_SIZE_X64);
      const view = new DataView(structure.buffer);
      view.setUint32(4, CRED_TYPE_GENERIC, true);
      view.setBigUint64(8, pointerValue(target), true);
      view.setUint32(32, blob.byteLength, true);
      view.setBigUint64(40, pointerValue(blob), true);
      view.setUint32(48, CRED_PERSIST_LOCAL_MACHINE, true);
      view.setBigUint64(72, pointerValue(userName), true);
      if (!advapi.symbols.CredWriteW(structure, 0)) {
        throw new Error(
          `Windows Credential Manager write failed (${kernel.symbols.GetLastError()})`,
        );
      }
    });
  }

  delete(key: string): void {
    const target = this.target(key);
    withLibraries((advapi, kernel) => {
      if (advapi.symbols.CredDeleteW(target, CRED_TYPE_GENERIC, 0)) return;
      const code = kernel.symbols.GetLastError();
      if (code !== ERROR_NOT_FOUND) {
        throw new Error(`Windows Credential Manager delete failed (${code})`);
      }
    });
  }
}

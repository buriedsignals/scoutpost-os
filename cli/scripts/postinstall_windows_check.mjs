import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { inspectWindowsSignature } from "./postinstall.js";

test(
  "Windows PowerShell bridge inspects an Authenticode-signed system binary",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const systemRoot = process.env.SystemRoot;
    assert.ok(systemRoot, "SystemRoot is required on Windows");
    const powershell = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    assert.ok(existsSync(powershell), "Windows PowerShell is required");

    const signature = inspectWindowsSignature(powershell);
    assert.equal(signature.status, "Valid");
    assert.equal(typeof signature.subject, "string");
    assert.ok(signature.subject.length > 0, "publisher subject is required");
    assert.equal(typeof signature.timestamp, "boolean");
  },
);

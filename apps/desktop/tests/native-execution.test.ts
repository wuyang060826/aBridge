import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../../tools/lib/process.js";

test(
  "native execution preserves desktop, file and shell boundaries",
  { skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 120_000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "abridge-native-execution-"));
    const root = resolve(import.meta.dirname, "../../..");
    const runtime = join(root, "apps/desktop/native/runtime");
    const sdk = join(root, "node_modules/@trycua/cua-driver-darwin-arm64");
    try {
      const executable = join(work, "execution-tests");
      await run("/usr/bin/swiftc", [
        "-swift-version",
        "6",
        "-parse-as-library",
        "-target",
        "arm64-apple-macos14.0",
        "-import-objc-header",
        join(runtime, "cua_driver_abi.h"),
        ...["JSON", "NativeDriver", "Computer", "Executor"].map((name) => join(runtime, `${name}.swift`)),
        join(root, "apps/desktop/tests/native-execution.swift"),
        "-L",
        sdk,
        "-lcua_driver_sdk",
        "-Xlinker",
        "-rpath",
        "-Xlinker",
        sdk,
        "-o",
        executable,
      ]);
      assert.match(await run(executable, [], { timeout: 30_000 }), /PASS native execution/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

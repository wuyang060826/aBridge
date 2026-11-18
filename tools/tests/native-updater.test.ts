import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../lib/process.js";

test(
  "native updater enforces release and archive boundaries",
  { skip: process.platform !== "darwin" },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "abridge-updater-test-"));
    const root = resolve(import.meta.dirname, "../..");
    try {
      const executable = join(work, "updater-tests");
      await run("/usr/bin/swiftc", [
        join(root, "apps/desktop/native/runtime/Updater.swift"),
        join(root, "tools/fixtures/updater-tests.swift"),
        "-o",
        executable,
      ]);
      assert.match(await run(executable, []), /PASS native updater/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

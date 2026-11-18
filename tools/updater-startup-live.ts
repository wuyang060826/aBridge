import { tmpdir } from "node:os";
/** Exercise the real App's startup receipt, without hardware permissions or a Server. */
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./lib/process.js";

if (process.platform !== "darwin") throw Error("Requires macOS");
const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(tmpdir(), "abridge-updater-startup-"));
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version as string;
const template = join(root, "dist/desktop/aBridge.app");
const updater = join(template, "Contents/MacOS/abridge-updater");
try {
  const brokenSource = join(work, "broken.swift"),
    brokenRuntime = join(work, "broken-runtime-helper");
  await writeFile(brokenSource, 'import Darwin\nprint("invalid JSON")\nexit(1)\n');
  await run("/usr/bin/swiftc", [brokenSource, "-o", brokenRuntime]);
  for (const [name, error, broken] of [
    ["empty error", "", false],
    ["server unavailable", "Server connection unavailable", false],
    ["broken runtime", "", true],
  ] as const) {
    const dir = join(work, name.replaceAll(" ", "-"));
    const state = join(dir, "state"),
      staging = join(dir, ".abridge-update-fixture");
    const app = join(dir, "aBridge.app"),
      candidate = join(staging, "aBridge.app");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(state, "status.json"), JSON.stringify({ connection: "connected", error }), {
      mode: 0o600,
    });
    await cp(template, app, { recursive: true });
    await cp(template, candidate, { recursive: true });
    if (broken) {
      const executable = join(candidate, "Contents/MacOS/abridge-desktop");
      await cp(brokenRuntime, executable);
      await run("/usr/bin/codesign", ["--force", "--sign", "-", executable]);
      await run("/usr/bin/codesign", ["--force", "--sign", "-", candidate]);
    }
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Set :CFBundleShortVersionString 0.0.0",
      join(app, "Contents/Info.plist"),
    ]);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", app]);
    const plan = join(staging, "plan.json");
    await writeFile(
      plan,
      JSON.stringify({
        app,
        candidate,
        work: staging,
        stateDir: state,
        version,
        current: "0.0.0",
        parent: 2147483647,
      }),
    );
    try {
      await run(updater, ["apply", plan], { timeout: 45000 });
      const installed = await run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        join(app, "Contents/Info.plist"),
      ]);
      assert.equal(installed, broken ? "0.0.0" : version, name);
      // The restored App consumes update-error.log, so it is not a stable rollback assertion.
      if (!broken) await assert.rejects(access(join(state, "logs/update-error.log")));
      console.log(`PASS real App startup: ${name}${broken ? " rolls back" : " keeps the update"}`);
    } finally {
      // applyUpdate launches detached Apps, including the restored old App.
      await delay(200);
      const processes = await run("/bin/ps", ["-axo", "pid=,command="]);
      for (const line of processes.split("\n")) {
        if (!line.includes(join(dir, "aBridge.app/Contents/MacOS/aBridge"))) continue;
        try {
          process.kill(Number(line.trim().split(/\s+/)[0]), "SIGTERM");
        } catch {}
      }
    }
  }
} finally {
  // Real App launches save custom state paths; remove only this fixture's entries.
  await run("/usr/bin/swift", [
    "-e",
    `import Foundation
let defaults = UserDefaults(suiteName: "dev.abridge.client")!
if let saved = defaults.dictionary(forKey: "aBridgeStateDirectories") as? [String:String] {
    let prefix = URL(fileURLWithPath: ${JSON.stringify(work)}).resolvingSymlinksInPath().path
    defaults.set(saved.filter { !URL(fileURLWithPath: $0.key).resolvingSymlinksInPath().path.hasPrefix(prefix) }, forKey: "aBridgeStateDirectories")
}`,
  ]);
  await rm(work, { recursive: true, force: true });
}

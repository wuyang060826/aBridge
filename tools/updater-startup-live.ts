/** Exercise the real App's startup receipt, without hardware permissions or a Server. */
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyUpdate } from "../apps/desktop/src/updater.js";
import { buildNative } from "./build-native.js";
import { run } from "./lib/process.js";

if (process.platform !== "darwin") throw Error("Requires macOS");
const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(root, ".local/updater-startup-"));
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version as string;
const cli = join(work, "cli.mjs");
try {
  // Only status/startup-check use the product CLI. Environment diagnosis is stubbed
  // so this test cannot request permissions or load the desktop driver.
  await writeFile(
    cli,
    `import {execFileSync} from 'node:child_process';
import {appendFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2),state=args[args.indexOf('--state-dir')+1];
appendFileSync(state+'/runtime-invocations',args.at(-1)+'\\n');
if(existsSync(state+'/broken-runtime')){console.log('invalid JSON');process.exit(1)}
if(args.includes('status')||args.includes('startup-check'))process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(join(root, "dist/desktop/cli.js"))},...args]));
else console.log('{}');
`,
  );
  const template = join(work, "template.app");
  await buildNative({ output: template, node: process.execPath, cli, stateDir: work, signingIdentity: "-" });
  for (const [name, error, broken] of [
    ["empty error", "", false],
    ["server unavailable", "Server connection unavailable", false],
    ["broken runtime", "", true],
  ] as const) {
    const dir = join(work, name.replaceAll(" ", "-"));
    const state = join(dir, "state"),
      staging = join(dir, "staging");
    const app = join(dir, "aBridge.app"),
      candidate = join(staging, "aBridge.app");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(state, "status.json"), JSON.stringify({ connection: "connected", error }), {
      mode: 0o600,
    });
    if (broken) await writeFile(join(state, "broken-runtime"), "");
    await cp(template, app, { recursive: true });
    await cp(template, candidate, { recursive: true });
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
      await applyUpdate(plan);
      const installed = await run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        join(app, "Contents/Info.plist"),
      ]);
      assert.equal(installed, broken ? "0.0.0" : version, name);
      assert.ok(
        (await readFile(join(state, "runtime-invocations"), "utf8")).split("\n").includes("startup-check"),
      );
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
    defaults.set(saved.filter { !$0.key.hasPrefix(${JSON.stringify(work)}) }, forKey: "aBridgeStateDirectories")
}`,
  ]);
  await rm(work, { recursive: true, force: true });
}

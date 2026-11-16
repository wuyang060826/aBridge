/** Opt-in real macOS rename/restart/rollback acceptance using disposable signed Apps. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { acquireOfficialNode } from "./lib/node-runtime.js";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { installUpdate } from "../apps/desktop/src/updater.js";
import { plist } from "./build-native.js";
import { run } from "./lib/process.js";
if (process.platform !== "darwin") throw Error("Requires macOS");
const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".local/updater-live-"));
const app = join(work, "aBridge.app"),
  state = join(work, "state"),
  pids = new Set<number>();
const portableNode = (await acquireOfficialNode(join(homedir(), "Library/Caches/aBridge/Node"))).node;
async function fixture(path: string, version: string) {
  await mkdir(join(path, "Contents/MacOS"), { recursive: true });
  await copyFile(join(work, "fixture"), join(path, "Contents/MacOS/aBridge"));
  await writeFile(
    join(path, "Contents/Info.plist"),
    plist({
      CFBundleIdentifier: "dev.abridge.client",
      CFBundleExecutable: "aBridge",
      CFBundleName: "aBridge Update Fixture",
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
      LSUIElement: true,
    }),
  );
  await run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
}
async function stage(version: string, current: string) {
  const staging = await mkdtemp(join(work, ".abridge-update-"));
  await fixture(join(staging, "aBridge.app"), version);
  await copyFile(portableNode, join(staging, "node"));
  await chmod(join(staging, "node"), 0o700);
  await copyFile(join(root, "dist/desktop/updater.mjs"), join(staging, "updater.mjs"));
  const plan = join(staging, "plan.json");
  await writeFile(
    plan,
    JSON.stringify({
      app,
      candidate: join(staging, "aBridge.app"),
      work: staging,
      version,
      current,
      parent: 0,
      stateDir: state,
    }),
  );
  return plan;
}
async function awaitVersion(version: string) {
  for (let i = 0; i < 400; i++) {
    try {
      const receipt = JSON.parse(await readFile(join(state, "fixture-pid.json"), "utf8"));
      if (receipt.version === version) {
        pids.add(receipt.pid);
        return receipt.pid as number;
      }
    } catch {}
    await delay(100);
  }
  throw Error("Fixture did not restart: " + version);
}
async function awaitCleanup(plan: string) {
  for (let i = 0; i < 400; i++) {
    try {
      await access(plan);
    } catch {
      return;
    }
    await delay(100);
  }
  throw Error("Helper did not finish");
}
try {
  await import("./updater-startup-live.js");
  await mkdir(state);
  await writeFile(join(state, "device.json"), "unchanged credential fixture");
  await run("/usr/bin/swiftc", [
    join(root, "tools/fixtures/updater.swift"),
    "-o",
    join(work, "fixture"),
    "-framework",
    "AppKit",
  ]);
  await fixture(app, "0.4.6");
  // Exercise real GitHub download, digest, ZIP and signature checks without installing it.
  if (!process.argv.includes("--skip-download")) {
    const downloadResult = JSON.parse(
      await run(
        process.execPath,
        [join(root, "dist/desktop/updater.mjs"), "download", app, "0.4.6", "0.4.7", state],
        { timeout: 240000 },
      ),
    );
    if (!downloadResult.plan) throw Error(downloadResult.error || "Missing download plan");
    const downloadPlan = downloadResult.plan as string;
    await rm(join(downloadPlan, ".."), { recursive: true, force: true });
    console.log("PASS official release download, digest and signature validation");
  }
  await fixture(app, "0.4.7");
  const old = spawn(join(app, "Contents/MacOS/aBridge"), ["--state-dir", state], { stdio: "ignore" });
  const oldPid = await awaitVersion("0.4.7");
  const plan = await stage("0.4.8", "0.4.7");
  await installUpdate(plan, oldPid);
  old.kill("SIGTERM");
  const newPid = await awaitVersion("0.4.8");
  await awaitCleanup(plan);
  await assert.rejects(access(app + ".previous-update"));
  console.log("PASS detached helper waits, replaces at original path and confirms restart");
  const failedPlan = await stage("0.4.9", "0.4.8");
  await rm(join(state, "fixture-pid.json"));
  await installUpdate(failedPlan, newPid);
  process.kill(newPid, "SIGTERM");
  await awaitVersion("0.4.8");
  await awaitCleanup(failedPlan);
  assert.match(await readFile(join(state, "logs/update-error.log"), "utf8"), /启动退出|未确认启动/);
  assert.equal(await readFile(join(state, "device.json"), "utf8"), "unchanged credential fixture");
  console.log("PASS startup failure restores and relaunches the old App; credentials unchanged");
  const recoveredPid = await awaitVersion("0.4.8");
  const stuckPlan = await stage("0.4.10", "0.4.8");
  await rm(join(state, "fixture-pid.json"));
  await installUpdate(stuckPlan, recoveredPid);
  process.kill(recoveredPid, "SIGTERM");
  const stuckPid = await awaitVersion("0.4.10");
  const restoredPid = await awaitVersion("0.4.8");
  await awaitCleanup(stuckPlan);
  assert.throws(() => process.kill(stuckPid, 0));
  console.log("PASS unready process ignoring SIGTERM is stopped before rollback");
  const waitingPlan = await stage("0.4.10", "0.4.8");
  await installUpdate(waitingPlan, restoredPid);
  await awaitCleanup(waitingPlan);
  const stillRunning = JSON.parse(await readFile(join(state, "fixture-pid.json"), "utf8"));
  assert.equal(stillRunning.pid, restoredPid);
  assert.match(await readFile(join(state, "logs/update-error.log"), "utf8"), /应用未退出/);
  console.log("PASS parent exit timeout preserves running App without launching a duplicate");
} catch (error) {
  for (const name of ["update-helper.log", "update-error.log"])
    console.error(name, await readFile(join(state, "logs", name), "utf8").catch(() => "missing"));
  throw error;
} finally {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await rm(work, { recursive: true, force: true });
}

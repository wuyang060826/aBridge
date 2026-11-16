/** macOS update transactions. Only explicit local App actions enter this module. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const RELEASES = "https://api.github.com/repos/xerrors/aBridge/releases/latest";
const MAX_DOWNLOAD = 300 * 1024 * 1024;
export type Update = { version: string; url: string; digest: string; size: number };
type Release = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
async function run(file: string, args: string[]): Promise<string> {
  return (await exec(file, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw Error("仅支持正式版本更新");
    const parts = value.split(".").map(Number);
    if (!parts.every(Number.isSafeInteger)) throw Error("版本号无效");
    return parts;
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}
export function selectUpdate(release: Release, current: string): Update | null {
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string")
    throw Error("更新源没有提供正式版本");
  const version = release.tag_name.replace(/^v/, "");
  if (compareVersions(version, current) <= 0) return null;
  if (!Array.isArray(release.assets)) throw Error("更新缺少下载文件");
  for (const suffix of ["notarized", "unsigned"]) {
    const name = `aBridge-${version}-macos-arm64-${suffix}.zip`;
    const asset = release.assets.find((a) => a?.name === name);
    if (!asset) continue;
    const expected = `https://github.com/xerrors/aBridge/releases/download/v${version}/${name}`;
    if (
      asset.browser_download_url !== expected ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > MAX_DOWNLOAD
    )
      throw Error("更新文件缺少有效校验信息");
    return { version, url: expected, digest: asset.digest.slice(7), size: asset.size };
  }
  throw Error("这个版本没有可用的 Apple Silicon 安装包");
}
export async function checkUpdate(current: string): Promise<Update | null> {
  const response = await fetch(RELEASES, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "aBridge-updater" },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok) throw Error(`检查更新失败（HTTP ${response.status}）`);
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw Error("更新信息过大");
  return selectUpdate(JSON.parse(text), current);
}
export async function assertApp(app: string, version?: string): Promise<void> {
  const stat = await lstat(app);
  if (!app.endsWith(".app") || !stat.isDirectory() || stat.isSymbolicLink()) throw Error("应用路径无效");
  const info = JSON.parse(
    await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")]),
  );
  if (
    info.CFBundleIdentifier !== "dev.abridge.client" ||
    (version && info.CFBundleShortVersionString !== version)
  )
    throw Error("安装包的应用身份或版本不匹配");
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
}
async function team(app: string): Promise<string | undefined> {
  const result = await exec("/usr/bin/codesign", ["-dv", "--verbose=4", app]);
  const value = result.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
  return value && value !== "not set" ? value : undefined;
}
export function validateArchivePaths(names: string[]): void {
  if (
    !names.length ||
    names.some(
      (name) =>
        !name.startsWith("aBridge.app/") ||
        name.includes("\\") ||
        name.split("/").some((part) => part === ".." || part === "."),
    )
  )
    throw Error("安装包包含无效路径");
}
async function rejectSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error("安装包包含符号链接");
    if (entry.isDirectory()) await rejectSymlinks(join(directory, entry.name));
  }
}
async function download(update: Update, file: string): Promise<void> {
  let url = update.url;
  const signal = AbortSignal.timeout(180000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
        parsed.hostname,
      )
    )
      throw Error("下载地址不受信任");
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw Error("下载重定向无效");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) throw Error(`下载失败（HTTP ${response.status}）`);
    const handle = await open(file, "wx", 0o600),
      hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > update.size || bytes > MAX_DOWNLOAD) throw Error("下载大小不匹配");
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
    } finally {
      await handle.close();
    }
    if (bytes !== update.size || hash.digest("hex") !== update.digest)
      throw Error("安装包校验失败，请重新下载");
    return;
  }
  throw Error("下载重定向过多");
}
type Plan = {
  app: string;
  candidate: string;
  work: string;
  version: string;
  current: string;
  parent: number;
  stateDir: string;
};
export async function prepareUpdate(
  app: string,
  current: string,
  version: string,
  stateDir: string,
): Promise<string> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("更新仅支持 Apple Silicon macOS");
  app = resolve(app);
  if (app.includes("/AppTranslocation/") || app.startsWith("/Volumes/"))
    throw Error("请先将 aBridge 移到 Applications 后再更新");
  await assertApp(app, current);
  await access(dirname(app), constants.W_OK);
  const update = await checkUpdate(current);
  if (!update || update.version !== version) throw Error("可用版本已变化，请重新检查更新");
  // Stage beside the installation so the final renames stay on the same volume.
  const work = await mkdtemp(join(dirname(app), ".abridge-update-"));
  await chmod(work, 0o700);
  const terminate = () => {
    void rm(work, { recursive: true, force: true }).finally(() => process.exit(1));
  };
  process.once("SIGTERM", terminate);
  try {
    const archive = join(work, "update.zip"),
      candidate = join(work, "aBridge.app");
    await download(update, archive);
    validateArchivePaths((await run("/usr/bin/unzip", ["-Z", "-1", archive])).split("\n"));
    await run("/usr/bin/ditto", ["-x", "-k", archive, work]);
    await rejectSymlinks(candidate);
    await assertApp(candidate, version);
    const currentTeam = await team(app);
    if (currentTeam && currentTeam !== (await team(candidate))) throw Error("更新的签名团队与当前应用不同");
    const metadata = JSON.parse(await readFile(join(candidate, "Contents/Resources/runtime.json"), "utf8"));
    if (metadata.runtime_mode !== "bundled") throw Error("更新缺少独立运行时");
    await access(join(candidate, "Contents/Resources/runtime/node"), constants.X_OK);
    await access(join(candidate, "Contents/Resources/runtime/cli.js"), constants.R_OK);
    const smokeState = join(work, "smoke-state");
    JSON.parse(
      await run(join(candidate, "Contents/Resources/runtime/node"), [
        join(candidate, "Contents/Resources/runtime/cli.js"),
        "status",
        "--state-dir",
        smokeState,
      ]),
    );
    await rm(smokeState, { recursive: true, force: true });
    // The helper survives replacement of the old App and needs no npm dependencies.
    await copyFile(process.execPath, join(work, "node"));
    await chmod(join(work, "node"), 0o700);
    await copyFile(join(dirname(process.argv[1]!), "updater.mjs"), join(work, "updater.mjs"));
    const plan: Plan = { app, candidate, work, version, current, parent: 0, stateDir: resolve(stateDir) };
    await writeFile(join(work, "plan.json"), JSON.stringify(plan), { mode: 0o600 });
    await rm(archive);
    return join(work, "plan.json");
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  } finally {
    process.off("SIGTERM", terminate);
  }
}
export async function installUpdate(planFile: string, parent: number): Promise<void> {
  const plan = JSON.parse(await readFile(planFile, "utf8")) as Plan;
  if (
    !Number.isSafeInteger(parent) ||
    parent <= 1 ||
    dirname(planFile) !== plan.work ||
    plan.candidate !== join(plan.work, "aBridge.app") ||
    dirname(plan.work) !== dirname(plan.app)
  )
    throw Error("更新计划无效");
  await assertApp(plan.app, plan.current);
  await assertApp(plan.candidate, plan.version);
  const currentTeam = await team(plan.app);
  if (currentTeam && currentTeam !== (await team(plan.candidate))) throw Error("签名团队不匹配");
  await run(join(plan.work, "node"), ["--version"]);
  plan.parent = parent;
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
  await mkdir(join(plan.stateDir, "logs"), { recursive: true, mode: 0o700 });
  const log = await open(join(plan.stateDir, "logs/update-helper.log"), "w", 0o600);
  try {
    const child = spawn(join(plan.work, "node"), [join(plan.work, "updater.mjs"), "apply", planFile], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, ABRIDGE_PARENT_PID: "" },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}
/** Keep the backup until launch succeeds; never touch account or permission state. */
export async function replaceApp(app: string, candidate: string, launch: () => Promise<void>): Promise<void> {
  const backup = app + ".previous-update";
  try {
    await lstat(backup);
    throw Error("发现上次更新备份，请先恢复或移走它");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(app, backup);
  try {
    await rename(candidate, app);
    await launch();
  } catch (error) {
    if (error instanceof RecoveryRequired) throw error;
    // Preserve the failed candidate and restore the old application at its original path.
    try {
      await rename(app, candidate);
    } catch (moveError) {
      if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") throw moveError;
    }
    try {
      await rename(backup, app);
    } catch {
      throw new RecoveryRequired("恢复旧版失败，已保留备份，请手动恢复");
    }
    throw error;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => {});
}

class RecoveryRequired extends Error {}
function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}
async function launchApp(app: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(join(app, "Contents/MacOS/aBridge"), args, { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return child;
}
async function stopFailedLaunch(child: ChildProcess): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!isRunning(child)) return;
    child.kill(signal);
    for (let i = 0; i < 30 && isRunning(child); i++) await delay(100);
  }
  if (isRunning(child)) throw new RecoveryRequired("新版本未能退出，已保留旧版备份，请退出应用后恢复");
}
async function launchUpdatedApp(
  app: string,
  version: string,
  stateDir: string,
  receipt: string,
): Promise<void> {
  // Launch the bundle executable directly so its PID is known even before AppKit starts.
  const child = await launchApp(app, ["--state-dir", stateDir, "--update-receipt", receipt]);
  try {
    for (let i = 0; i < 150; i++) {
      if (!isRunning(child)) throw Error("新版本启动退出，已恢复旧版");
      try {
        const status = JSON.parse(await readFile(receipt, "utf8"));
        if (status.version === version && status.ready === true && status.pid === child.pid) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(100);
    }
    throw Error("新版本未确认启动，已恢复旧版");
  } catch (error) {
    await stopFailedLaunch(child);
    throw error;
  }
}

export async function applyUpdate(planFile: string): Promise<void> {
  const plan = JSON.parse(await readFile(planFile, "utf8")) as Plan;
  let parentExited = false,
    preserveRecovery = false;
  try {
    for (let i = 0; ; i++) {
      let running = true;
      try {
        process.kill(plan.parent, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        running = false;
      }
      if (!running) break;
      if (i >= 300) throw Error("应用未退出，已取消安装");
      await delay(100);
    }
    parentExited = true;
    await assertApp(plan.candidate, plan.version);
    await replaceApp(plan.app, plan.candidate, async () => {
      await launchUpdatedApp(plan.app, plan.version, plan.stateDir, join(plan.work, "startup.json"));
    });
  } catch (error) {
    preserveRecovery = error instanceof RecoveryRequired;
    await mkdir(join(plan.stateDir, "logs"), { recursive: true, mode: 0o700 });
    await writeFile(join(plan.stateDir, "logs/update-error.log"), String(error), { mode: 0o600 });
    if (parentExited && !preserveRecovery)
      await launchApp(plan.app, ["--state-dir", plan.stateDir]).catch(() => {});
  } finally {
    if (!preserveRecovery) await rm(plan.work, { recursive: true, force: true });
  }
}

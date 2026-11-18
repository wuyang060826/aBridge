/** Portable Windows candidate. No installer, global settings, or production credentials. */
import { createReadStream, closeSync, existsSync, openSync, writeSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Zip, ZipDeflate } from "fflate";
import { copyDependencyClosure, externalPackages } from "./lib/dependency-closure.js";

if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Build the Windows x64 package on Windows x64.");
const root = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
// Pin the official distribution and its published SHASUMS256.txt digest.
const nodeVersion = "24.22.3";
const nodeDigest = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f";
const sdkVersion = "10.0.404";
const dotnet = existsSync(join(root, ".local/dotnet/dotnet.exe"))
  ? join(root, ".local/dotnet/dotnet.exe")
  : "dotnet";
// Select the pinned SDK even when a newer SDK is also installed on a CI runner.
const buildDirectory = join(root, ".local/release/windows/build");
await mkdir(buildDirectory, { recursive: true });
await writeFile(
  join(buildDirectory, "global.json"),
  JSON.stringify({ sdk: { version: sdkVersion, rollForward: "disable" } }),
);
const sdkProbe = spawnSync(dotnet, ["--version"], {
  cwd: buildDirectory,
  encoding: "utf8",
  windowsHide: true,
});
if (sdkProbe.status !== 0 || sdkProbe.stdout.trim() !== sdkVersion)
  throw Error(`Windows packaging requires .NET SDK ${sdkVersion} (PATH or .local/dotnet).`);
const sdkList = spawnSync(dotnet, ["--list-sdks"], { encoding: "utf8", windowsHide: true });
const sdkDirectory = sdkList.stdout
  .split(/\r?\n/)
  .find((line) => line.startsWith(`${sdkVersion} [`))
  ?.match(/\[(.+)\]$/)?.[1];
if (!sdkDirectory) throw Error("Cannot locate the selected .NET SDK distribution notices.");
// Reuse the canonical 256px PNG already exported in the macOS icon set.
const iconset = await readFile(join(root, "apps/desktop/native/assets/AppIcon.icns"));
let iconPng: Buffer | undefined;
for (let offset = 8; offset + 8 <= iconset.length;) {
  const length = iconset.readUInt32BE(offset + 4);
  if (length < 8 || offset + length > iconset.length) throw Error("Invalid canonical app icon.");
  if (iconset.toString("ascii", offset, offset + 4) === "ic08")
    iconPng = iconset.subarray(offset + 8, offset + length);
  offset += length;
}
if (!iconPng || iconPng.readUInt32BE(16) !== 256 || iconPng.readUInt32BE(20) !== 256)
  throw Error("Canonical app icon must contain a 256px PNG.");
const iconHeader = Buffer.alloc(22);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(1, 4);
iconHeader.writeUInt16LE(1, 10);
iconHeader.writeUInt16LE(32, 12);
iconHeader.writeUInt32LE(iconPng.length, 14);
iconHeader.writeUInt32LE(22, 18);
const icon = join(buildDirectory, "app.ico");
await writeFile(icon, Buffer.concat([iconHeader, iconPng]));
const downloads = join(root, ".local/downloads");
await mkdir(downloads, { recursive: true });
const nodeArchive = join(downloads, `node-v${nodeVersion}-win-x64.zip`);
if (!existsSync(nodeArchive)) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw Error(`Node download failed: HTTP ${response.status}`);
  await writeFile(nodeArchive, new Uint8Array(await response.arrayBuffer()));
}
if (
  createHash("sha256")
    .update(await readFile(nodeArchive))
    .digest("hex") !== nodeDigest
)
  throw Error("Official Node archive checksum mismatch; remove the invalid cached download.");
const unpack = spawnSync("tar.exe", ["-xf", nodeArchive, "-C", downloads], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 60000,
});
if (unpack.status !== 0) throw Error(`Cannot unpack Node: ${unpack.stderr}`);
const nodeSource = join(downloads, `node-v${nodeVersion}-win-x64`);
const stage = resolve(root, ".local/release/windows/aBridge");
const releaseRoot = resolve(root, ".local/release/windows");
if (dirname(stage) !== releaseRoot || !stage.startsWith(root + sep)) throw Error("Unsafe staging path.");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const publish = spawnSync(
  dotnet,
  [
    "publish",
    join(root, "apps/windows/windows-native-shell/aBridge.csproj"),
    "--disable-build-servers",
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-o",
    stage,
    `-p:Version=${metadata.version}`,
    `-p:ApplicationIcon=${icon}`,
    "-p:DebugType=None",
    "-p:DebugSymbols=false",
    "-p:UseSharedCompilation=false",
  ],
  {
    cwd: buildDirectory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
  },
);
if (publish.status !== 0) throw Error(`Native Windows publish failed:\n${publish.stdout}\n${publish.stderr}`);
await cp(join(dirname(sdkDirectory), "LICENSE.txt"), join(stage, "DotNet-LICENSE.txt"));
await cp(join(dirname(sdkDirectory), "ThirdPartyNotices.txt"), join(stage, "DotNet-THIRD-PARTY-NOTICES.txt"));
await cp(join(root, "apps/desktop/native/assets/AppIcon.png"), join(stage, "icon.png"));
const app = join(stage, "runtime");
await mkdir(app, { recursive: true });
await cp(join(nodeSource, "node.exe"), join(app, "node.exe"));
await cp(join(nodeSource, "LICENSE"), join(app, "Node-LICENSE"));
for (const file of ["cli.js", "windows-host.mjs"])
  await cp(join(root, "dist/windows", file), join(app, file));
const metafile = JSON.parse(await readFile(join(root, "dist/windows/cli.meta.json"), "utf8"));
const hostMetafile = JSON.parse(await readFile(join(root, "dist/windows/windows-host.meta.json"), "utf8"));
const dependencies = [...new Set([...externalPackages(metafile), ...externalPackages(hostMetafile)])].filter(
  (name) => name !== "@trycua/cua-driver",
);
if (dependencies.some((name) => name !== "ws" && name !== "zod"))
  throw Error("Review the Windows runtime dependency boundary before packaging.");
const closure = await copyDependencyClosure(root, join(app, "node_modules"), dependencies);
await writeFile(
  join(app, "package.json"),
  JSON.stringify(
    {
      name: "abridge-desktop",
      version: metadata.version,
      private: true,
      type: "module",
      main: "windows-host.mjs",
    },
    null,
    2,
  ) + "\n",
);
await cp(join(root, "LICENSE"), join(app, "LICENSE"));
await cp(join(root, "docs/third-party-notices.md"), join(app, "THIRD_PARTY_NOTICES.md"));
await writeFile(
  join(app, "runtime-manifest.json"),
  JSON.stringify(
    {
      version: metadata.version,
      platform: "win32",
      arch: "x64",
      node: nodeVersion,
      dotnetSdk: sdkVersion,
      shell: "WPF",
      dependencies: closure,
    },
    null,
    2,
  ) + "\n",
);
const probe = spawnSync(
  join(app, "node.exe"),
  ["-e", "require('node:sqlite'); process.stdout.write(process.versions.node)"],
  {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  },
);
if (probe.status !== 0) throw Error("Packaged Node runtime cannot load node:sqlite.");
const cliProbe = spawnSync(join(app, "node.exe"), [join(app, "cli.js"), "--help"], {
  cwd: stage,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30000,
});
if (cliProbe.status !== 0 || !cliProbe.stdout.includes("state-dir"))
  throw Error("Packaged Desktop CLI failed its startup probe.");
// Deployment-specific paths and credentials are deliberately absent from this package.
await writeFile(
  join(stage, "Start-aBridge.ps1"),
  `param([string]$StateDir)
$ErrorActionPreference = 'Stop'
if (-not $StateDir) {
  $deploymentPath = Join-Path $PSScriptRoot 'deployment.json'
  if (Test-Path -LiteralPath $deploymentPath) {
    $deployment = Get-Content -LiteralPath $deploymentPath -Raw | ConvertFrom-Json
    $StateDir = $deployment.state_dir
  }
}
if ($StateDir) {
  & (Join-Path $PSScriptRoot 'aBridge.exe') --state-dir $StateDir
} else {
  & (Join-Path $PSScriptRoot 'aBridge.exe')
}
`,
);
const dist = join(root, "dist/releases");
await mkdir(dist, { recursive: true });
const output = join(dist, `aBridge-${metadata.version}-windows-x64-unsigned.zip`);
const descriptor = openSync(output, "w");
try {
  const zip = new Zip((error, data) => {
    if (error) throw error;
    writeSync(descriptor, data);
  });
  const collect = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("Windows packages cannot contain symbolic links.");
      if (entry.isDirectory()) await collect(file);
      else {
        const compressed = new ZipDeflate("aBridge/" + relative(stage, file).split(sep).join("/"), {
          level: 6,
        });
        compressed.mtime = new Date("2020-01-01T00:00:00Z");
        zip.add(compressed);
        for await (const chunk of createReadStream(file)) compressed.push(chunk, false);
        compressed.push(new Uint8Array(), true);
      }
    }
  };
  await collect(stage);
  zip.end();
} finally {
  closeSync(descriptor);
}
console.log(
  `Packaged unsigned Windows x64 ${metadata.version}, embedded Node ${probe.stdout.trim()}: ${output}`,
);

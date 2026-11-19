/** Consume the portable candidate outside the repository, without any real device state. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Check the Windows package on Windows x64");
const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const archive = join(root, "dist/releases", `aBridge-${version}-windows-x64-unsigned.zip`);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
assert.equal(await readFile(archive + ".sha256", "utf8"), `${hash.digest("hex")}  ${basename(archive)}\n`);
const listing = spawnSync("tar.exe", ["-tf", archive], {
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});
assert.equal(listing.status, 0, listing.stderr);
const entries = listing.stdout.trim().split(/\r?\n/);
for (const entry of entries) {
  assert.ok(entry.startsWith("aBridge/") && !entry.includes("\\") && !entry.includes(":"), entry);
  assert.ok(!entry.split("/").some((part) => part === ".." || part === ".git" || part === ".local"), entry);
  assert.ok(
    !/(?:^|\/)(?:deployment|config|credential|control-auth)\.json$|\.db(?:-|$)|\.map$|cua-driver/.test(entry),
    entry,
  );
  assert.ok(
    !/\.(?:deps\.json|runtimeconfig\.json)$|DotNet-|(?:^|\/)(?:coreclr|clrjit|hostfxr|hostpolicy|System\.Private\.CoreLib)\.dll$/i.test(
      entry,
    ),
    `Unexpected managed runtime: ${entry}`,
  );
}
const directory = await mkdtemp(join(tmpdir(), "abridge-windows-package-"));
assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
try {
  const unpack = spawnSync("tar.exe", ["-xf", archive, "-C", directory], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(unpack.status, 0, unpack.stderr);
  const app = join(directory, "aBridge"),
    runtime = join(app, "runtime");
  for (const file of [
    "aBridge.exe",
    "README.md",
    "runtime/node.exe",
    "runtime/cli.js",
    "runtime/windows-host.mjs",
    "runtime/LICENSE",
    "runtime/Node-LICENSE",
    "Rust-THIRD-PARTY-NOTICES.txt",
    "Start-aBridge.ps1",
    "naui-winappsdk.manifest",
    "Microsoft.UI.Xaml.dll",
    "resources.pri",
    "WindowsAppSDK-LICENSE.txt",
    "WindowsAppSDK-NOTICE.txt",
  ])
    await access(join(app, file));
  for (const entry of entries.filter((entry) => /\.(dll|exe)$/i.test(entry))) {
    const binary = await readFile(join(directory, entry));
    assert.equal(binary.subarray(0, 2).toString(), "MZ", entry);
    const header = binary.readUInt32LE(0x3c);
    assert.equal(binary.subarray(header, header + 4).toString(), "PE\0\0", entry);
    const optional = header + 24;
    const magic = binary.readUInt16LE(optional);
    assert.ok(magic === 0x20b || magic === 0x10b, entry);
    const directories = optional + (magic === 0x20b ? 112 : 96);
    assert.equal(
      binary.readUInt32LE(directories + 14 * 8),
      0,
      `Managed assembly in portable bundle: ${entry}`,
    );
  }
  const executable = await readFile(join(app, "aBridge.exe"));
  assert.ok(
    executable.includes(Buffer.from("Microsoft.UI.Xaml.Application")),
    "Shell must embed the app-local WinUI activation manifest",
  );
  assert.equal(executable.subarray(0, 2).toString(), "MZ");
  const pe = executable.readUInt32LE(0x3c);
  assert.equal(executable.subarray(pe, pe + 4).toString(), "PE\0\0");
  assert.equal(executable.readUInt16LE(pe + 4), 0x8664, "Shell must target x64");
  const optional = pe + 24;
  assert.equal(executable.readUInt16LE(optional), 0x20b, "Shell must be PE32+");
  assert.equal(executable.readUInt16LE(optional + 68), 2, "Shell must use the GUI subsystem");
  assert.equal(executable.readUInt32LE(optional + 112 + 14 * 8), 0, "Shell must not load the CLR");
  const manifest = JSON.parse(await readFile(join(runtime, "runtime-manifest.json"), "utf8")) as {
    version: string;
    platform: string;
    shell: string;
    source_commit: string | null;
    source_dirty: boolean | null;
  };
  assert.equal(manifest.version, version);
  assert.equal(manifest.platform, "win32");
  assert.equal(manifest.shell, "Rust + WinUI 3");
  assert.ok(manifest.source_commit === null || /^[a-f0-9]{40}$/.test(manifest.source_commit));
  // An empty state directory means no credentials, network connection or real desktop actions.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|TEMP|TMP|LOCALAPPDATA)$/i.test(key)),
  );
  const node = join(runtime, "node.exe"),
    cli = join(runtime, "cli.js");
  const help = spawnSync(node, [cli, "--help"], {
    cwd: directory,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /state-dir/);
  const status = spawnSync(node, [cli, "status", "--state-dir", join(directory, "empty-state")], {
    cwd: directory,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout) as { connected?: boolean };
  assert.notEqual(snapshot.connected, true);
  console.log(
    `Verified Windows ZIP, checksum, native shell, documentation and isolated CLI startup (${entries.length} entries; source ${manifest.source_commit ?? "unknown"}, dirty=${manifest.source_dirty})`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

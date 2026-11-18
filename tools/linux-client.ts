/** Build the Rust device client from the shared protocol and package only Linux executables. */
import { desktopContract } from "@abridge/protocol/desktop-contract";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { target: { type: "string" } },
});
const action = positionals[0];
if (positionals.length !== 1 || !["build", "check", "package", "contract"].includes(action ?? "")) {
  throw Error("Usage: npm run linux:build | linux:check | package:linux [-- --target <Rust target>]");
}
const full = desktopContract();
const selectedSchemas = new Set([
  "operation",
  "welcome",
  "deviceIdentity",
  "command_execute",
  "files_list",
  "file_read",
  "file_write",
]);
const contract = {
  version: full.version,
  protocol: full.protocol,
  capabilities: full.capabilities,
  toolCapabilities: full.toolCapabilities,
  limits: full.limits,
  schemas: Object.fromEntries(Object.entries(full.schemas).filter(([name]) => selectedSchemas.has(name))),
};
const contractFile = join(root, "build/linux-client/contract.json");
mkdirSync(dirname(contractFile), { recursive: true });
writeFileSync(contractFile, JSON.stringify(contract) + "\n");
if (action === "contract") process.exit(0);

const env: NodeJS.ProcessEnv = {
  ...process.env,
  ABRIDGE_CONTRACT_PATH: contractFile,
  CARGO_TARGET_DIR: resolve(process.env.CARGO_TARGET_DIR ?? join(root, "build/linux-client/target")),
};
function execute(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error)
    throw Error(`Unable to run ${command}; install Rust with rustfmt and clippy`, { cause: result.error });
  if (result.status !== 0) throw Error(`${command} ${args[0]} failed (${result.status ?? result.signal})`);
  return result.stdout ?? "";
}
const manifest = join(root, "apps/linux-client/Cargo.toml");
const manifestArgs = ["--manifest-path", manifest];
const cargo = "cargo",
  rustc = "rustc";
const host = /^host: (.+)$/m.exec(execute(rustc, ["-vV"], true))?.[1];
if (!host) throw Error("Unable to determine the Rust host target");
const target = values.target ?? host;
if (!/^(?:aarch64|x86_64)-(?:unknown-linux-(?:gnu|musl)|apple-darwin)$/.test(target))
  throw Error(`Unsupported build target: ${target}`);
const targetArgs = ["--target", target];
if (action === "check") {
  if (target !== host)
    throw Error("Run linux:check on the target platform; cross-built tests cannot run here");
  execute(cargo, ["fmt", ...manifestArgs, "--", "--check"]);
  execute(cargo, ["test", ...manifestArgs, "--locked", ...targetArgs]);
  execute(cargo, [
    "clippy",
    ...manifestArgs,
    "--locked",
    ...targetArgs,
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]);
  execute(cargo, ["build", ...manifestArgs, "--locked", ...targetArgs]);
  env.ABRIDGE_LINUX_CLIENT_BINARY = join(env.CARGO_TARGET_DIR!, target, "debug/abridge-client");
  execute(process.execPath, ["--import", "tsx", "--test", "apps/linux-client/tests/client.test.ts"]);
  process.exit(0);
}
if (action === "package" && !target.includes("-linux-"))
  throw Error("package:linux requires a Linux host or an explicit Linux --target with a configured linker");
execute(cargo, ["build", ...manifestArgs, "--locked", "--release", ...targetArgs]);
const built = join(env.CARGO_TARGET_DIR!, target, "release/abridge-client");
const outputDirectory = join(root, "dist/linux-client", target);
mkdirSync(outputDirectory, { recursive: true });
const binaryPath = join(outputDirectory, "abridge-client");
copyFileSync(built, binaryPath);
chmodSync(binaryPath, 0o755);
const binary = readFileSync(binaryPath);
if (binary.length > 15 * 1024 * 1024)
  throw Error(`Linux client exceeds the 15 MiB executable budget (${binary.length} bytes)`);
console.log(`Built ${binaryPath}: ${binary.length} bytes`);
if (action !== "package") process.exit(0);
if (!binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
  throw Error("Linux package must contain an ELF executable");
const metadata = JSON.parse(
  execute(
    cargo,
    ["metadata", ...manifestArgs, "--locked", "--format-version", "1", "--filter-platform", target],
    true,
  ),
) as {
  resolve: { nodes: { id: string }[] };
  packages: {
    id: string;
    name: string;
    version: string;
    license: string | null;
    manifest_path: string;
    source: string | null;
  }[];
};
const resolvedPackages = new Set(metadata.resolve.nodes.map((node) => node.id));
let notices = "aBridge Linux client third-party notices\n\n";
for (const pkg of metadata.packages
  .filter((pkg) => pkg.source && resolvedPackages.has(pkg.id))
  .sort((a, b) => a.name.localeCompare(b.name))) {
  notices += `\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? "See included license text"}\n`;
  const directory = dirname(pkg.manifest_path);
  for (const file of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (file.isFile() && /^(LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(file.name)) {
      notices += `\n--- ${file.name} ---\n${readFileSync(join(directory, file.name), "utf8")}\n`;
    }
  }
}
// Minimal deterministic ustar archive: fixed paths, ownership, timestamps and modes.
function tar(files: { name: string; data: Buffer; executable?: boolean }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const field = (offset: number, width: number, value: string) =>
      header.write(value, offset, width, "ascii");
    const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";
    field(0, 100, file.name);
    field(100, 8, octal(file.executable ? 0o755 : 0o644, 8));
    field(108, 8, octal(0, 8));
    field(116, 8, octal(0, 8));
    field(124, 12, octal(file.data.length, 12));
    field(136, 12, octal(0, 12));
    field(148, 8, "        ");
    field(156, 1, "0");
    field(257, 6, "ustar\0");
    field(263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    chunks.push(header, file.data, Buffer.alloc((512 - (file.data.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
const sysroot = execute(rustc, ["--print", "sysroot"], true).trim();
const rustNotices = readFileSync(join(sysroot, "share/doc/rust/COPYRIGHT-library.html"));
const archive = gzipSync(
  tar([
    { name: "abridge-client", data: binary, executable: true },
    { name: "LICENSE", data: readFileSync(join(root, "LICENSE")) },
    { name: "README.md", data: readFileSync(join(root, "apps/linux-client/README.md")) },
    { name: "THIRD_PARTY_NOTICES.txt", data: Buffer.from(notices) },
    { name: "RUST_COPYRIGHT.html", data: rustNotices },
  ]),
  { level: 9 },
);
if (archive.length > 5 * 1024 * 1024)
  throw Error(`Linux client exceeds the 5 MiB download budget (${archive.length} bytes)`);
const releases = join(root, "dist/releases");
mkdirSync(releases, { recursive: true });
const filename = `abridge-client-${full.version}-${target}.tar.gz`;
writeFileSync(join(releases, filename), archive);
writeFileSync(
  join(releases, filename + ".sha256"),
  `${createHash("sha256").update(archive).digest("hex")}  ${filename}\n`,
);
writeFileSync(
  join(releases, filename + ".size.json"),
  JSON.stringify(
    { version: full.version, target, executable_bytes: binary.length, download_bytes: archive.length },
    null,
    2,
  ) + "\n",
);
console.log(`Packaged ${filename}: ${archive.length} bytes`);

/** Reject private state, desktop native dependencies and source-only inputs in Server packages. */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
import { serverShrinkwrap, type PackageLock, type DistributionManifest } from "./lib/server-lock.js";
const root = resolve(import.meta.dirname, ".."),
  dist = join(root, "dist/releases");
const files = await readdir(dist),
  tarballs = files.filter((n) => !n.startsWith("._") && n.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error("Expected exactly one Server tarball");
const listing = spawnSync("tar", ["-tzf", join(dist, tarballs[0]!)], { encoding: "utf8" });
if (listing.status !== 0) throw new Error("Cannot inspect Server tarball");
const entries = listing.stdout.trim().split("\n");
for (const name of entries) {
  if (
    !/^package\/(cli\.js|package\.json|npm-shrinkwrap\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|web\/)/.test(
      name,
    )
  )
    throw new Error(`Unexpected Server package entry: ${name}`);
}
function archiveJson(name: string): unknown {
  const result = spawnSync("tar", ["-xOf", join(dist, tarballs[0]!), `package/${name}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Cannot read ${name} from Server tarball`);
  return JSON.parse(result.stdout) as unknown;
}
const pkg = archiveJson("package.json") as Record<string, unknown>;
if (pkg.optionalDependencies || JSON.stringify(pkg.dependencies).includes("cua-driver"))
  throw new Error("Server must not install desktop native dependencies");
const lock = archiveJson("npm-shrinkwrap.json") as {
  packages: Record<string, unknown>;
};
if (Object.keys(lock.packages).some((name) => /cua-driver|@ubjs|typescript|esbuild/.test(name)))
  throw new Error("Server dependency lock contains desktop or build dependencies");
const sourceLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as PackageLock;
const expectedLock = serverShrinkwrap(sourceLock, pkg as DistributionManifest);
if (JSON.stringify(lock) !== JSON.stringify(expectedLock))
  throw new Error("Server dependency lock differs from the tested production graph");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const browser = `abridge-browser-${metadata.version}.zip`;
if (!files.includes(browser)) throw new Error("Browser ZIP for the current version is missing");
const archive = unzipSync(await readFile(join(dist, browser)));
const manifest = JSON.parse(new TextDecoder().decode(archive["manifest.json"])) as Record<string, unknown>;
if ("key" in manifest) throw new Error("Chrome Web Store manifest must not contain a key field");
if (manifest.version !== metadata.version)
  throw new Error("Browser manifest version must match the product version");
for (const name of Object.keys(archive)) {
  if (name.includes("..") || /\.local|node_modules|tests\/|\.ts$|\.map$/.test(name))
    throw new Error(`Unexpected extension entry: ${name}`);
}
console.log(`Verified Server tarball (${entries.length} files) and extension ZIP`);

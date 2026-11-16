import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, selectUpdate, validateArchivePaths, replaceApp } from "../src/updater.js";

const asset = (suffix = "unsigned") => ({
  name: `aBridge-0.4.8-macos-arm64-${suffix}.zip`,
  browser_download_url: `https://github.com/xerrors/aBridge/releases/download/v0.4.8/aBridge-0.4.8-macos-arm64-${suffix}.zip`,
  digest: `sha256:${"a".repeat(64)}`,
  size: 123,
});
const release = () => ({ tag_name: "v0.4.8", draft: false, prerelease: false, assets: [asset()] });
test("updates compare numeric versions and require an exact official asset with a digest", () => {
  assert.equal(compareVersions("0.4.10", "0.4.9"), 1);
  assert.equal(selectUpdate(release(), "0.4.8"), null);
  assert.equal(selectUpdate(release(), "1.0.0"), null);
  assert.equal(selectUpdate(release(), "0.4.7")?.version, "0.4.8");
  assert.ok(
    selectUpdate({ ...release(), assets: [asset(), asset("notarized")] }, "0.4.7")?.url.endsWith(
      "-notarized.zip",
    ),
  );
  for (const invalid of [
    { ...release(), prerelease: true },
    { ...release(), draft: true },
    { ...release(), tag_name: "v0.4.8-beta" },
    { ...release(), assets: [{ ...asset(), digest: null }] },
    { ...release(), assets: [{ ...asset(), browser_download_url: "https://example.com/app.zip" }] },
    { ...release(), assets: [{ ...asset(), size: 400 * 1024 * 1024 }] },
  ])
    assert.throws(() => selectUpdate(invalid, "0.4.7"));
});
test("archive entries cannot escape the single App root", () => {
  validateArchivePaths(["aBridge.app/", "aBridge.app/Contents/Info.plist"]);
  for (const path of [
    "../escape",
    "/aBridge.app/Contents",
    "aBridge.app/../../escape",
    "aBridge.app/./bad",
    "other.app/Contents",
    "aBridge.app/..\\escape",
  ])
    assert.throws(() => validateArchivePaths([path]));
});
test("replacement keeps the original path and rolls back a failed restart without touching state", async () => {
  const root = await mkdtemp(join(tmpdir(), "abridge-update-test-"));
  const app = join(root, "aBridge.app"),
    candidate = join(root, "candidate.app"),
    state = join(root, "device.json");
  try {
    await mkdir(app);
    await mkdir(candidate);
    await writeFile(join(app, "version"), "old");
    await writeFile(join(candidate, "version"), "new");
    await writeFile(state, "credential fixture");
    await assert.rejects(
      replaceApp(app, candidate, async () => {
        assert.equal(await readFile(join(app, "version"), "utf8"), "new");
        throw Error("launch failed");
      }),
      /launch failed/,
    );
    assert.equal(await readFile(join(app, "version"), "utf8"), "old");
    assert.equal(await readFile(join(candidate, "version"), "utf8"), "new");
    await replaceApp(app, candidate, async () => {});
    assert.equal(await readFile(join(app, "version"), "utf8"), "new");
    assert.equal(await readFile(state, "utf8"), "credential fixture");
    await assert.rejects(access(app + ".previous-update"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("an existing recovery backup blocks replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "abridge-update-test-"));
  try {
    const app = join(root, "aBridge.app");
    await mkdir(app);
    await mkdir(app + ".previous-update");
    await assert.rejects(
      replaceApp(app, join(root, "missing"), async () => {}),
      /备份/,
    );
    await access(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

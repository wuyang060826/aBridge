import { test } from "node:test";
import assert from "node:assert/strict";
import { platformIcon, platformName } from "../src/components/icons.js";
import { deviceSchema } from "../src/lib/api.js";

const device = {
  id: "fixture-device",
  name: "Fixture computer",
  kind: "computer",
  capabilities: ["shell"],
  status: "offline",
};

test("unknown platform metadata stays unknown in device labels and icons", () => {
  for (const platform of [undefined, null, "", " \t "]) {
    const parsed = deviceSchema.parse({ ...device, platform });
    assert.equal(parsed.platform, null);
    assert.equal(platformName(parsed.platform), "未知平台");
    assert.equal(platformIcon(parsed.platform), undefined);
  }
});

test("offline platforms retain their label without inventing a browser brand", () => {
  for (const status of ["online", "offline"]) {
    const computer = deviceSchema.parse({ ...device, status, platform: " win32 " });
    assert.equal(platformName(computer.platform), "Windows");
    assert.equal(platformIcon(computer.platform), "windows");
    const browser = deviceSchema.parse({
      ...device,
      status,
      kind: "browser",
      capabilities: ["browser"],
      platform: "Browser extension",
    });
    assert.equal(platformName(browser.platform), "浏览器扩展");
    assert.equal(platformIcon(browser.platform), undefined);
  }
});

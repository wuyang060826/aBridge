import { test } from "node:test";
import assert from "node:assert/strict";
import { browserPlatform } from "../src/browser-brand.js";

test("Chrome and derivatives use their declared Chrome brand", () => {
  // Chrome and current Ego both expose this same identity.
  const identity = {
    userAgent: "Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36",
    userAgentData: {
      brands: [
        { brand: "Not:A-Brand", version: "8" },
        { brand: "Chromium", version: "156" },
        { brand: "Google Chrome", version: "156" },
      ],
    },
  };
  assert.equal(browserPlatform(identity), "chrome");
  assert.equal(browserPlatform({ userAgent: identity.userAgent }), "chrome");
});

test("Chromium and other declared brands do not become Chrome from a compatibility token", () => {
  for (const brand of ["Chromium", "Microsoft Edge", "Opera", "Brave"]) {
    assert.equal(
      browserPlatform({ userAgent: "Chrome/156.0", userAgentData: { brands: [{ brand, version: "156" }] } }),
      "Browser extension",
    );
  }
  for (const token of ["Edg/156", "OPR/100", "Vivaldi/7", "SamsungBrowser/25"])
    assert.equal(browserPlatform({ userAgent: `Chrome/156.0 ${token}` }), "Browser extension");
  assert.equal(browserPlatform({}), "Browser extension");
});

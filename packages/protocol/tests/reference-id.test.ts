import { test } from "node:test";
import assert from "node:assert/strict";
import { createReferenceIdGenerator, observationIdSchema, snapshotIdSchema } from "@abridge/protocol";

test("public reference formats are short, typed and accept the full Base64URL alphabet", () => {
  assert.equal(observationIdSchema.parse("obs_Ab12_-xy"), "obs_Ab12_-xy");
  assert.equal(snapshotIdSchema.parse("snap_Ab12_-xy"), "snap_Ab12_-xy");
  for (const id of ["obs_1234567", "obs_123456789", "obs_1234567+", "obs_" + "a".repeat(32), "snap_12345678"])
    assert.equal(observationIdSchema.safeParse(id).success, false);
  assert.equal(snapshotIdSchema.safeParse("obs_12345678").success, false);
});

test("reference sequence does not recycle issued IDs at the 48-bit boundary", () => {
  const next = createReferenceIdGenerator(2 ** 48 - 2);
  assert.equal(next("obs"), "obs________-");
  assert.equal(next("snap"), "snap_________");
  assert.throws(() => next("obs"), /exhausted/);
});

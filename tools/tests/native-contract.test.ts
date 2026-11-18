import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { toolArgumentSchemas, deviceRenameSchema, deviceAuthorizationTokenSchema } from "@abridge/protocol";
import { run } from "../lib/process.js";

test(
  "native contract has the same defaults, strict fields and refinements as shared Zod schemas",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "abridge-contract-"));
    try {
      const binary = join(directory, "contract");
      await run("/usr/bin/swiftc", [
        "-swift-version",
        "6",
        resolve("apps/desktop/native/runtime/JSON.swift"),
        resolve("apps/desktop/native/runtime/Contract.swift"),
        resolve("tools/fixtures/native-contract.swift"),
        "-o",
        binary,
      ]);
      const schemas = {
        ...toolArgumentSchemas,
        deviceRename: deviceRenameSchema,
        deviceAuthorizationToken: deviceAuthorizationTokenSchema,
      };
      const samples: { schema: keyof typeof schemas; value: unknown }[] = [];
      const add = (schema: keyof typeof schemas, ...values: unknown[]) =>
        samples.push(...values.map((value) => ({ schema, value })));
      add("computer_apps", {}, { query: "Finder" }, { extra: 1 });
      add("computer_windows", { pid: 1 }, { pid: 0 }, { pid: 1.2 }, { pid: 2147483648 });
      add("computer_open", { app: "TextEdit" }, { app: "" });
      add(
        "computer_observe",
        {},
        { desktop: true },
        { desktop: true, pid: 1 },
        { window_id: 1 },
        { pid: 1, window_id: 2 },
        { screenshot: false },
      );
      for (const action of [
        { type: "click", x: 0, y: 1 },
        { type: "click", x: 0, y: 1, delivery_mode: "foreground" },
        { type: "click", x: 0, y: 1, delivery_mode: "automatic" },
        { type: "click", x: 1 },
        { type: "click", element_ref: "e1", x: 1, y: 2 },
        { type: "click", element_ref: "e1" },
        { type: "type", text: "a\0b" },
        { type: "type", text: "你好🙂" },
        { type: "scroll", delta_y: 1 },
        { type: "scroll", delta_y: 0 },
        { type: "scroll", delta_y: 1, delta_x: 1 },
        { type: "key", key: "A", modifiers: ["cmd"] },
        { type: "move", x: -1, y: 0 },
        { type: "drag", x: 0, y: 0, to_x: 10, to_y: 20 },
      ])
        add("computer_act", { observation_id: "obs_fixture1", action });
      add("computer_act", {
        observation_id: "obs_fixture1",
        action: { type: "key", key: "A" },
        screenshot: true,
        observe_after: false,
      });
      add(
        "command_execute",
        { command: "echo hi" },
        { command: " \n\t" },
        { command: "echo\0hi" },
        { command: "true", env: { "A=B": "x" } },
        { command: "true", env: { A: "\0" } },
        { command: "true", cwd: "/tmp\0" },
        { command: "true", timeout: 0 },
        { command: "true", timeout: 120 },
        { command: "true", timeout: 121 },
      );
      add(
        "files_list",
        { path: "/tmp" },
        { path: "/tmp", limit: 0 },
        { path: "/tmp", limit: 1.5 },
        { path: "/tmp", limit: 500 },
      );
      add("file_read", { path: "/tmp" }, { path: "/tmp", max_bytes: 1048577 });
      add(
        "file_write",
        { path: "/tmp", content: "🙂" },
        { path: "/tmp", content: "a".repeat(1048577) },
        { path: "/tmp", content: "🙂".repeat(262145) },
        { path: "/tmp", content: "\ud800" },
        { path: "/tmp", content: "x", overwrite: 1 },
      );
      add(
        "deviceRename",
        { name: "  Work Mac  " },
        { name: " " },
        { name: "a".repeat(121) },
        { name: "🙂".repeat(61) },
      );
      add(
        "deviceAuthorizationToken",
        { device_id: "x", name: "Mac", kind: "computer", key: "abr_device_fixture", capabilities: ["files"] },
        {
          device_id: "x",
          name: "Mac",
          kind: "computer",
          key: "abr_device_fixture",
          capabilities: ["files", "files"],
        },
      );
      const result = spawnSync(binary, [resolve("dist/desktop/desktop-contract.json")], {
        input: samples.map((s) => JSON.stringify(s)).join("\n") + "\n",
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr);
      const outputs = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { ok: boolean; value?: unknown });
      assert.equal(outputs.length, samples.length);
      for (const [index, sample] of samples.entries()) {
        const expected = schemas[sample.schema].safeParse(sample.value);
        assert.equal(
          outputs[index]!.ok,
          expected.success,
          `${sample.schema} sample ${index}: ${JSON.stringify(sample.value).slice(0, 200)}`,
        );
        if (expected.success)
          assert.deepEqual(outputs[index]!.value, expected.data, `${sample.schema} normalized ${index}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

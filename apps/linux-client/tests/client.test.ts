import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  VERSION,
  commandExecuteSchema,
  filesListSchema,
  fileReadSchema,
  fileWriteSchema,
  deviceWelcomeSchema,
  operationFrameSchema,
} from "@abridge/protocol";
import { createServer } from "../../server/src/server.js";

const binary = process.env.ABRIDGE_LINUX_CLIENT_BINARY;
if (binary) assert.ok(existsSync(binary), "ABRIDGE_LINUX_CLIENT_BINARY must exist");
const skip = binary ? false : "Run linux:check or set ABRIDGE_LINUX_CLIENT_BINARY";
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}

function start(args: string[]): {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  assert.ok(binary);
  const child = spawn(binary, args, { stdio: "pipe" });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function cli(args: string[], input?: unknown, expected: number | null = 0) {
  const process = start(args);
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 15000);
  try {
    process.child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    const result = await process.done;
    if (expected !== null) assert.equal(result.code, expected, result.stderr);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 8000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, description);
    await delay(30);
  }
}

async function fixture() {
  // Short paths also fit macOS's Unix socket path limit during host validation.
  const directory = await mkdtemp(join(tmpdir(), "abl-"));
  const state = join(directory, "client");
  const server = await createServer({ dbPath: join(directory, "server.db"), port: 0 });
  let running: ReturnType<typeof start> | undefined;
  try {
    const url = await server.start();
    const credentials = { username: "linux-fixture", password: "synthetic-linux-password" };
    const created = await fetch(url + "/api/admin/users", {
      method: "POST",
      headers: { authorization: `Bearer ${server.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(created.status, 201);
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.ok(response.ok, `Fixture API ${path}: ${response.status}`);
      return object(await response.json());
    };
    // Grant all computer capabilities to prove Linux does not advertise desktop support.
    const device = await api("/api/devices", {
      name: "Fixture Linux",
      kind: "computer",
      capabilities: ["shell", "files", "screen", "input"],
    });
    assert.equal(typeof device.id, "string");
    assert.equal(typeof device.key, "string");
    const agent = await api("/api/agent-connections", {
      name: "Fixture Agent",
      policy: { mode: "all", capabilities: ["shell", "files", "screen", "input"], overrides: [] },
    });
    const rpc = async (name: string, args: ObjectValue = {}) => {
      const response = await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${agent.key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(response.status, 200);
      const body = object(await response.json());
      const result = object(body.result);
      assert.ok(Array.isArray(result.content));
      const content = result.content.map(object).find((item) => item.type === "text");
      assert.equal(typeof content?.text, "string");
      return object(JSON.parse(content!.text as string));
    };
    const control = async (...args: string[]) =>
      object(JSON.parse((await cli([...args, "--state-dir", state])).stdout));
    const status = () => control("status");
    const bind = { url, device_key: device.key };
    await cli(["setup", "--stdin", "--state-dir", state], bind);
    const stop = async (verify = true) => {
      if (!running) return;
      const current = running;
      running = undefined;
      current.child.kill("SIGTERM");
      const timer = setTimeout(() => current.child.kill("SIGKILL"), 5000);
      try {
        const result = await current.done;
        if (verify) assert.equal(result.code, 0, result.stderr);
      } finally {
        clearTimeout(timer);
      }
    };
    const launch = async () => {
      assert.equal(running, undefined);
      running = start(["run", "--state-dir", state]);
      running.child.stdin.end();
      const current = running;
      await eventually(
        async () => {
          if (current.child.exitCode !== null || current.child.signalCode !== null) {
            const result = await current.done;
            assert.fail(`Rust client exited before readiness: ${result.stderr}`);
          }
          // A live process can own the state lock before the control socket is
          // listening. That transient status error is expected during startup.
          const result = await cli(["status", "--state-dir", state], undefined, null);
          return result.code === 0 ? object(JSON.parse(result.stdout)) : {};
        },
        (value) => value.connection === "online" || value.connection === "revoked",
        "Rust client did not connect",
      );
    };
    const open = async () => {
      const session = await rpc("session_open", { device_id: device.id, capabilities: ["shell", "files"] });
      assert.equal(typeof session.id, "string", JSON.stringify(session));
      return session.id as string;
    };
    return {
      ...server,
      directory,
      state,
      url,
      device,
      api,
      rpc,
      control,
      status,
      bind,
      stop,
      launch,
      open,
      async dispose() {
        try {
          await stop(false);
        } finally {
          await server.close();
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (running) running.child.kill("SIGKILL");
    await server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test(
  "Rust client matches shared protocol defaults, limits, property names and Unicode lengths",
  { skip },
  async () => {
    const schemas = {
      command_execute: commandExecuteSchema,
      files_list: filesListSchema,
      file_read: fileReadSchema,
      file_write: fileWriteSchema,
      welcome: deviceWelcomeSchema,
      operation: operationFrameSchema,
    };
    const cases: { schema: keyof typeof schemas; value: unknown }[] = [
      {
        schema: "operation",
        value: {
          type: "dispatch",
          protocol: "abridge/1",
          device_id: "fixture",
          connection_epoch: 1,
          sequence: 1,
          device_credential_version: 1,
          session_capabilities: ["shell"],
          operation_id: "op_fixture1",
          session_id: "ses_fixture1",
          tool: "command_execute",
          arguments: { command: "pwd", env: { FIXTURE: "value" } },
          expires_at: 2000000000,
        },
      },
      { schema: "command_execute", value: { command: "printf hello" } },
      {
        schema: "command_execute",
        value: { command: "printf hello", timeout: 1.5, env: { LANG: "C", 名: "值" } },
      },
      ...["", "\t\n", "\uFEFF", "x\0y", "😀".repeat(32769), "😀".repeat(65537)].map((command) => ({
        schema: "command_execute" as const,
        value: { command },
      })),
      ...[{ "A=B": "x" }, { "A\0B": "x" }, { A: "x\0y" }, { "": "x" }].map((env) => ({
        schema: "command_execute" as const,
        value: { command: "pwd", env },
      })),
      { schema: "command_execute", value: { command: "pwd", unexpected: true } },
      { schema: "command_execute", value: { command: "pwd", timeout: 121 } },
      { schema: "files_list", value: { path: "." } },
      { schema: "files_list", value: { path: ".", limit: 1 } },
      { schema: "files_list", value: { path: ".", limit: 1.5 } },
      { schema: "files_list", value: { path: ".", limit: 501 } },
      { schema: "files_list", value: { path: "😀".repeat(2048) } },
      { schema: "files_list", value: { path: "😀".repeat(2049) } },
      { schema: "files_list", value: { path: "😀".repeat(4097) } },
      { schema: "file_read", value: { path: "/fixture" } },
      { schema: "file_read", value: { path: "/fixture", max_bytes: 1048577 } },
      { schema: "file_read", value: { path: "/fixture\0" } },
      { schema: "file_write", value: { path: "/fixture", content: "中文 😀" } },
      { schema: "file_write", value: { path: "/fixture", content: "中".repeat(349526) } },
      { schema: "file_write", value: { path: "/fixture", content: "", overwrite: true } },
      { schema: "file_write", value: { path: "/fixture", content: "", overwrite: "true" } },
      {
        schema: "welcome",
        value: {
          type: "welcome",
          protocol: "abridge/1",
          device_id: "fixture",
          connection_epoch: 1,
          capabilities: ["shell", "files"],
          owner_name: "Fixture",
          lease_seconds: 30,
          heartbeat_interval: 10,
          extra: true,
        },
      },
    ];
    const result = await cli(["protocol-check", "--stdin"], cases);
    const actual: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, cases.length);
    for (const [index, item] of cases.entries()) {
      const expected = schemas[item.schema].safeParse(item.value);
      const entry = object(actual[index]);
      assert.equal(entry.ok, expected.success, `Protocol case ${index}: ${item.schema}`);
      if (expected.success) assert.deepEqual(entry.value, expected.data, `Normalized case ${index}`);
    }
    // Invalid surrogate escapes are rejected while decoding JSON, before execution.
    assert.equal(fileWriteSchema.safeParse({ path: "x", content: "\ud800" }).success, false);
    await cli(
      ["protocol-check", "--stdin"],
      { schema: "file_write", value: { path: "x", content: "\ud800" } },
      1,
    );
  },
);

test(
  "Rust client runs real Server/MCP shell and files, persists pause and rejects invalid rebinding",
  { skip, timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      await f.launch();
      const status = await f.status();
      assert.equal(status.platform, "linux");
      assert.equal(status.version, VERSION);
      assert.deepEqual(status.capabilities, {
        screen: false,
        input: false,
        shell: true,
        files: true,
        browser: false,
      });
      const listed = await f.rpc("devices_list");
      assert.ok(Array.isArray(listed.devices));
      const device = object(listed.devices[0]);
      const summary = object(device.details);
      assert.equal(summary.os, "linux");
      assert.equal("runtime_user" in summary, false);
      const full = await f.rpc("device_get", { device_id: device.id });
      const details = object(full.details);
      assert.equal(typeof details.hostname, "string");
      assert.equal(typeof details.runtime_user, "string");
      assert.equal(typeof details.architecture, "string");
      assert.equal(device.platform, "linux");
      assert.equal(device.version, VERSION);
      assert.deepEqual(object(device.available), {
        screen: false,
        input: false,
        shell: true,
        files: true,
      });
      const session = await f.open();
      const args = {
        session_id: session,
        command: "printf 'once\n' >> count; printf 'hello 😀'; printf error >&2",
        cwd: f.directory,
        operation_id: "fixture-once",
      };
      const command = await f.rpc("command_execute", args);
      assert.equal(command.status, "executed", JSON.stringify(command));
      assert.equal(object(command.result).stdout, "hello 😀");
      assert.equal(object(command.result).stderr, "error");
      assert.equal(object(command.result).exit_code, 0);
      const duplicate = await f.rpc("command_execute", args);
      assert.equal(duplicate.operation_id, command.operation_id);
      assert.equal(await readFile(join(f.directory, "count"), "utf8"), "once\n");
      const path = join(f.directory, "text.txt");
      const written = await f.rpc("file_write", { session_id: session, path, content: "你好 😀" });
      assert.equal(written.status, "executed", JSON.stringify(written));
      assert.equal(object(written.result).size, Buffer.byteLength("你好 😀"));
      const read = await f.rpc("file_read", { session_id: session, path });
      assert.equal(object(read.result).content, "你好 😀");
      const overwrite = await f.rpc("file_write", { session_id: session, path, content: "bad" });
      assert.equal(overwrite.status, "failed");
      assert.equal(await readFile(path, "utf8"), "你好 😀");
      const entries = await f.rpc("files_list", { session_id: session, path: f.directory });
      assert.ok(Array.isArray(object(entries.result).entries));
      assert.ok(
        (object(entries.result).entries as unknown[]).map(object).some((entry) => entry.name === "text.txt"),
      );

      assert.equal((await f.control("pause")).paused, true);
      await f.stop();
      const binding = await readFile(join(f.state, "binding.json"));
      await cli(
        ["setup", "--stdin", "--state-dir", f.state],
        { ...f.bind, device_key: "abr_device_invalid_fixture" },
        1,
      );
      assert.deepEqual(
        await readFile(join(f.state, "binding.json")),
        binding,
        "Failed validation must retain prior binding",
      );
      const browser = await f.api("/api/devices", {
        name: "Fixture browser",
        kind: "browser",
        capabilities: ["browser"],
      });
      await cli(["setup", "--stdin", "--state-dir", f.state], { ...f.bind, device_key: browser.key }, 1);
      assert.deepEqual(
        await readFile(join(f.state, "binding.json")),
        binding,
        "Wrong device type must retain prior binding",
      );
      await f.launch();
      assert.equal((await f.status()).paused, true, "Restart must preserve pause");
      const paused = await f.rpc("session_open", { device_id: f.device.id, capabilities: ["shell"] });
      assert.equal(object(paused.error).code, "device_paused");
      await f.control("resume");
      await eventually(
        async () => f.rpc("session_open", { device_id: f.device.id, capabilities: ["shell"] }),
        (value) => typeof value.id === "string",
        "Resume did not restore access",
      );
      const retained = await f.rpc("operation_status", {
        operation_id: command.operation_id,
        wait_seconds: 0,
      });
      assert.equal(retained.status, "executed");
      assert.equal(
        await readFile(join(f.directory, "count"), "utf8"),
        "once\n",
        "Reconnect must not replay completed commands",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "Rust capability shutdown cancels real shell descendants and revoked credentials stay disabled",
  { skip, timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      await f.launch();
      const session = await f.open();
      const command = await f.rpc("command_execute", {
        session_id: session,
        cwd: f.directory,
        command: "printf ready > started; (sleep 2; printf late > late) & wait",
        timeout: 10,
        wait_seconds: 0,
      });
      assert.equal(typeof command.operation_id, "string", JSON.stringify(command));
      await eventually(async () => existsSync(join(f.directory, "started")), Boolean, "Shell did not start");
      const disabled = await f.control("capability", "shell", "off");
      assert.equal(object(disabled.capabilities).shell, false);
      assert.equal(disabled.active_operations, 0, "Capability response must wait for cleanup");
      await delay(2200);
      assert.equal(existsSync(join(f.directory, "late")), false, "Cancelled descendant must not write later");
      const unavailable = await f.rpc("operation_status", {
        operation_id: command.operation_id,
        wait_seconds: 0,
      });
      assert.equal(object(unavailable.error).code, "capability_unavailable");
      await f.stop();
      await f.launch();
      assert.equal(
        object((await f.status()).capabilities).shell,
        false,
        "Restart must preserve capability switch",
      );
      await f.control("capability", "shell", "on");
      const terminal = await eventually(
        () => f.rpc("operation_status", { operation_id: command.operation_id, wait_seconds: 0 }),
        (value) => value.status !== undefined,
        "Re-enabling shell did not restore result access",
      );
      assert.equal(terminal.status, "outcome_unknown", JSON.stringify(terminal));
      await f.api(`/api/devices/${f.device.id}/revoke`, {});
      await eventually(f.status, (value) => value.revoked === true, "Server revocation was not persisted");
      await cli(["resume", "--state-dir", f.state], undefined, 1);
      await f.stop();
      await f.launch();
      const revoked = await f.status();
      assert.equal(revoked.revoked, true);
      assert.equal(revoked.paused, true);
      assert.equal(revoked.connection, "revoked");
    } finally {
      await f.dispose();
    }
  },
);

test(
  "Rust journal refuses direct replay across reconnect/restart and session closure stops admission",
  { skip, timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "abl-peer-"));
    const state = join(directory, "state");
    const key = "abr_device_synthetic_peer_fixture";
    const server = createHttpServer((request, response) => {
      if (request.url !== "/api/device" || request.headers.authorization !== `Bearer ${key}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "fixtureDevice",
          name: "Fixture",
          kind: "computer",
          capabilities: ["shell", "files"],
        }),
      );
    });
    const peers = new WebSocketServer({ server, path: "/ws/device" });
    let peer: WebSocket | undefined;
    let epoch = 0,
      welcomed = 0,
      sequence = 0;
    const messages: ObjectValue[] = [];
    peers.on("connection", (socket) => {
      peer = socket;
      const connectionEpoch = ++epoch;
      sequence = 0;
      socket.on("message", (bytes) => {
        const frame = object(JSON.parse(bytes.toString()));
        if (frame.type === "hello") {
          assert.equal(frame.platform, "linux");
          socket.send(
            JSON.stringify({
              type: "welcome",
              protocol: "abridge/1",
              device_id: "fixtureDevice",
              device_name: "Fixture",
              connection_epoch: connectionEpoch,
              capabilities: ["shell", "files"],
              owner_name: "Synthetic owner",
              lease_seconds: 30,
              heartbeat_interval: 10,
            }),
          );
          welcomed = connectionEpoch;
        } else if (frame.type === "heartbeat") {
          socket.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: connectionEpoch }));
        } else messages.push(frame);
      });
    });
    let running: ReturnType<typeof start> | undefined;
    const stop = async () => {
      if (!running) return;
      const current = running;
      running = undefined;
      current.child.kill("SIGTERM");
      const timer = setTimeout(() => current.child.kill("SIGKILL"), 5000);
      try {
        await current.done;
      } finally {
        clearTimeout(timer);
      }
    };
    const send = (frame: ObjectValue) => {
      assert.ok(peer && peer.readyState === WebSocket.OPEN);
      peer.send(JSON.stringify({ ...frame, connection_epoch: epoch }));
    };
    const dispatch = (id: string, session: string, command: string) => {
      const begin = messages.length;
      send({
        type: "dispatch",
        protocol: "abridge/1",
        device_id: "fixtureDevice",
        sequence: ++sequence,
        device_credential_version: 1,
        session_capabilities: ["shell"],
        operation_id: id,
        session_id: session,
        tool: "command_execute",
        arguments: { command, cwd: directory, timeout: 10 },
        expires_at: Date.now() / 1000 + 30,
      });
      return begin;
    };
    const receipt = async (id: string, begin: number) => {
      const value = await eventually(
        async () => messages.slice(begin).find((item) => item.type === "result" && item.operation_id === id),
        Boolean,
        "Missing direct operation receipt",
      );
      assert.ok(value);
      return value;
    };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      await cli(["setup", "--stdin", "--state-dir", state], {
        url: `http://127.0.0.1:${address.port}`,
        device_key: key,
      });
      const launch = async () => {
        const previous = welcomed;
        running = start(["run", "--state-dir", state]);
        running.child.stdin.end();
        await eventually(
          async () => welcomed,
          (value) => value > previous,
          "Client did not welcome fake peer",
        );
      };
      await launch();
      const once = "printf once >> count; printf done";
      let begin = dispatch("op_journal1", "ses_journal1", once);
      assert.equal((await receipt("op_journal1", begin)).status, "executed");
      begin = dispatch("op_journal1", "ses_journal1", once);
      assert.equal(object((await receipt("op_journal1", begin)).result).deduplicated, true);
      begin = dispatch("op_journal1", "ses_journal1", "printf conflict >> count");
      assert.equal(object((await receipt("op_journal1", begin)).error).code, "idempotency_conflict");

      const cancelled = "printf ready; sleep 2; printf late > late";
      begin = dispatch("op_journal2", "ses_journal2", cancelled);
      await eventually(
        async () =>
          messages
            .slice(begin)
            .some((frame) => frame.type === "output" && frame.operation_id === "op_journal2"),
        Boolean,
        "Command did not begin",
      );
      send({ type: "session_close", session_id: "ses_journal2" });
      assert.equal((await receipt("op_journal2", begin)).status, "outcome_unknown");
      begin = dispatch("op_journal3", "ses_journal2", "printf forbidden > closed-session");
      assert.equal(object((await receipt("op_journal3", begin)).error).code, "session_closed");

      const priorEpoch = welcomed;
      peer!.terminate();
      await eventually(
        async () => welcomed,
        (value) => value > priorEpoch,
        "Client did not reconnect",
      );
      begin = dispatch("op_journal2", "ses_journal2", cancelled);
      const unknown = await receipt("op_journal2", begin);
      assert.equal(unknown.status, "outcome_unknown");
      assert.equal(object(unknown.result).deduplicated, true);
      await stop();
      await launch();
      begin = dispatch("op_journal1", "ses_journal1", once);
      const persisted = await receipt("op_journal1", begin);
      assert.equal(persisted.status, "executed");
      assert.equal(object(persisted.result).deduplicated, true);
      assert.equal(await readFile(join(directory, "count"), "utf8"), "once");
      await delay(1100);
      assert.equal(existsSync(join(directory, "late")), false);
      assert.equal(existsSync(join(directory, "closed-session")), false);
    } finally {
      await stop();
      for (const socket of peers.clients) socket.terminate();
      await new Promise<void>((resolve) => peers.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);

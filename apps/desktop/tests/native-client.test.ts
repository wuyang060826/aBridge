import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { VERSION } from "@abridge/protocol";
const exec = promisify(execFile);
const binary = resolve(
  process.env.ABRIDGE_NATIVE_TEST_APP ?? "dist/desktop/aBridge.app",
  "Contents/MacOS/abridge-desktop",
);
const native = process.platform === "darwin" && process.arch === "arm64";
type Frame = Record<string, unknown>;
async function until<T>(
  check: () => T | Promise<T>,
  message = "Expected state",
  timeout = 8000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw Error(message);
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abridge-native-client-"));
  await chmod(directory, 0o700);
  let name = "Fixture Mac",
    responseId = "fixture",
    reject = false;
  const http = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer abr_device_fixture");
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method === "PATCH") name = (JSON.parse(body) as { name: string }).name;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.method === "PATCH"
          ? { id: responseId, name }
          : { id: responseId, name, kind: "computer", capabilities: ["shell", "files"] },
      ),
    );
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const server = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    if (reject) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    assert.equal(request.headers.authorization, "Bearer abr_device_fixture");
    server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws));
  });
  let peer: WebSocket | undefined,
    epoch = 0,
    sequence = 0,
    child: ChildProcess | undefined;
  let stderr = "";
  const frames: Frame[] = [];
  let binaryFrames = 0;
  server.on("connection", (socket) => {
    peer = socket;
    epoch++;
    sequence = 0;
    socket.on("message", (bytes, isBinary) => {
      // The production device endpoint accepts JSON text frames only.
      if (isBinary) {
        binaryFrames++;
        socket.close(4400, "JSON text is required");
        return;
      }
      const frame = JSON.parse(bytes.toString()) as Frame;
      frames.push(frame);
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "fixture",
            device_name: name,
            connection_epoch: epoch,
            capabilities: ["shell", "files"],
            owner_name: "Fixture Owner",
            lease_seconds: 30,
            heartbeat_interval: 10,
          }),
        );
      if (frame.type === "heartbeat")
        socket.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: epoch, device_name: name }));
      if (frame.type === "unbind") socket.send(JSON.stringify({ type: "revoke", connection_epoch: epoch }));
    });
  });
  await mkdir(join(directory, "credentials"), { mode: 0o700 });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      url,
      paused: false,
      capabilities: { shell: true, files: true, screen: false, input: false },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "credentials/device.json"),
    JSON.stringify({ server_url: url, device_key: "abr_device_fixture" }),
    { mode: 0o600 },
  );
  async function cli(...args: string[]): Promise<Frame> {
    const result = await exec(binary, [...args, "--state-dir", directory], { timeout: 20000 });
    return JSON.parse(result.stdout) as Frame;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const running = child;
    const exited = new Promise<void>((done) => running.once("exit", () => done()));
    running.kill("SIGTERM");
    const forced = setTimeout(() => running.kill("SIGKILL"), 6000);
    await exited;
    clearTimeout(forced);
  }
  async function start() {
    child = spawn(binary, ["run", "--state-dir", directory], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (data) => {
      stderr += String(data);
    });
    child.stdout!.on("data", (data) => {
      stderr += String(data);
    });
    await until(async () => {
      assert.equal(binaryFrames, 0, "Native client must send JSON text WebSocket frames");
      const status = await cli("status");
      return status.connection === "online" && status;
    }, `Native client failed: ${stderr}`);
  }
  function dispatch(id: string, tool: string, args: Frame, extra: Frame = {}) {
    peer!.send(
      JSON.stringify({
        type: "dispatch",
        protocol: "abridge/1",
        device_id: "fixture",
        connection_epoch: epoch,
        sequence: ++sequence,
        device_credential_version: 1,
        session_capabilities: ["shell", "files"],
        operation_id: id,
        session_id: "fixture_session",
        client_name: "Fixture Agent",
        tool,
        arguments: args,
        expires_at: Date.now() / 1000 + 30,
        ...extra,
      }),
    );
  }
  async function result(id: string, after = 0) {
    return until(
      () => frames.slice(after).find((f) => f.type === "result" && f.operation_id === id),
      `Missing result ${id}; ${stderr}`,
    );
  }
  return {
    directory,
    url,
    cli,
    start,
    stop,
    dispatch,
    result,
    frames,
    get peer() {
      return peer!;
    },
    get epoch() {
      return epoch;
    },
    set name(value: string) {
      name = value;
    },
    set responseId(value: string) {
      responseId = value;
    },
    set reject(value: boolean) {
      reject = value;
    },
    async close() {
      await stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done) => server.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  "native client: startup loads independently of broken binding and bundles no JS runtime",
  { skip: !native },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "abridge-native-startup-"));
    try {
      const status = JSON.parse(
        (await exec(binary, ["status", "--state-dir", join(dir, "not-created")])).stdout,
      ) as Frame;
      assert.equal(status.connection, "offline");
      assert.deepEqual(await readdir(dir), []);
      await writeFile(join(dir, "config.json"), "broken binding", { mode: 0o600 });
      const { stdout } = await exec(binary, ["startup-check", "--state-dir", dir]);
      assert.deepEqual(JSON.parse(stdout), { ready: true, native: true, version: VERSION });
      assert.equal(await readFile(join(dir, "config.json"), "utf8"), "broken binding");
      const smoke = JSON.parse(
        (await exec(binary, ["smoke", "--state-dir", dir], { timeout: 30000 })).stdout,
      ) as Frame;
      assert.equal(smoke.embedded, true);
      assert.equal(smoke.desktop_actions, 0);
      assert.equal(smoke.authorizations, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "native client: signed runtime speaks protocol, persists no-replay journal and rejects invalid admission",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      const hello = f.frames.find((frame) => frame.type === "hello")!;
      assert.equal(hello.platform, "darwin");
      assert.equal(hello.version, VERSION);
      assert.deepEqual(hello.capabilities, {
        browser: false,
        files: true,
        input: false,
        screen: false,
        shell: true,
      });
      const file = join(f.directory, "effect.txt");
      f.dispatch("write_once", "file_write", { path: file, content: "first" });
      assert.equal((await f.result("write_once")).status, "executed");
      const offset = f.frames.length;
      f.dispatch("write_once", "file_write", { path: file, content: "first" });
      assert.equal((await f.result("write_once", offset)).status, "executed");
      assert.deepEqual((await f.result("write_once", offset)).result, {
        deduplicated: true,
        prior_status: "executed",
      });
      const offset2 = f.frames.length;
      f.dispatch("write_once", "file_write", { path: file, content: "changed" });
      assert.equal(((await f.result("write_once", offset2)).error as Frame).code, "idempotency_conflict");
      f.dispatch("nul", "command_execute", { command: "echo\0secret" });
      assert.equal(((await f.result("nul")).error as Frame).code, "invalid_arguments");
      f.dispatch("expired", "files_list", { path: f.directory }, { expires_at: Date.now() / 1000 - 1 });
      assert.equal(((await f.result("expired")).error as Frame).code, "dispatch_expired");
      f.dispatch("browser", "browser_open", { url: "https://example.com" });
      assert.equal(((await f.result("browser")).error as Frame).code, "capability_unavailable");
      f.dispatch("denied", "file_read", { path: file }, { session_capabilities: ["shell"] });
      assert.equal(((await f.result("denied")).error as Frame).code, "capability_unavailable");
      await f.stop();
      await f.start();
      const afterRestart = f.frames.length;
      f.dispatch("write_once", "file_write", { path: file, content: "first" });
      assert.equal(((await f.result("write_once", afterRestart)).error as Frame).code, "duplicate_operation");
      assert.equal(await readFile(file, "utf8"), "first");
    } finally {
      await f.close();
    }
  },
);

test(
  "native client: pause cancels process groups, survives reconnect and never replays an interrupted write",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      const file = join(f.directory, "must-not-exist");
      f.dispatch("interrupted", "command_execute", { command: `sleep 10; printf effect > '${file}'` });
      await until(async () => (await f.cli("status")).active_operations === 1);
      assert.equal((await f.cli("control", "pause")).paused, true);
      const receipt = await f.result("interrupted");
      assert.equal(receipt.status, "outcome_unknown");
      f.peer.terminate();
      await until(() => f.frames.filter((x) => x.type === "hello").length === 2);
      await until(async () => (await f.cli("status")).connection === "online");
      assert.equal((await f.cli("status")).paused, true);
      f.dispatch("paused", "files_list", { path: f.directory });
      assert.equal(((await f.result("paused")).error as Frame).code, "device_paused");
      await f.cli("control", "resume");
      const offset = f.frames.length;
      f.dispatch("interrupted", "command_execute", { command: `sleep 10; printf effect > '${file}'` });
      assert.equal((await f.result("interrupted", offset)).status, "outcome_unknown");
      await assert.rejects(readFile(file));
      await f.cli("control", "capability", "--capability", "files", "--enabled", "false");
      f.dispatch("disabled", "files_list", { path: f.directory });
      assert.equal(((await f.result("disabled")).error as Frame).code, "capability_unavailable");
    } finally {
      await f.close();
    }
  },
);

test(
  "native client: names, local controls, closed sessions and unbind preserve lifecycle boundaries",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      assert.equal((await f.cli("status")).device_name, "Fixture Mac");
      const credentials = await readFile(join(f.directory, "credentials/device.json"));
      assert.equal((await f.cli("control", "rename", "--name", "  New Mac  ")).device_name, "New Mac");
      assert.deepEqual(await readFile(join(f.directory, "credentials/device.json")), credentials);
      f.name = "Console Name";
      f.peer.send(
        JSON.stringify({ type: "heartbeat_ack", connection_epoch: f.epoch, device_name: "Console Name" }),
      );
      await until(async () => (await f.cli("status")).device_name === "Console Name");
      f.responseId = "wrong";
      await assert.rejects(f.cli("control", "rename", "--name", "wrong-device"));
      f.peer.send(
        JSON.stringify({ type: "session_close", connection_epoch: f.epoch, session_id: "fixture_session" }),
      );
      f.dispatch("closed", "files_list", { path: f.directory });
      assert.equal(((await f.result("closed")).error as Frame).code, "session_closed");
      const result = await f.cli("control", "unbind");
      assert.equal(result.unbound, true);
      assert.equal(result.cloud_revoked, true);
      await assert.rejects(readFile(join(f.directory, "credentials/device.json")));
      const status = await until(async () => {
        const value = await f.cli("status");
        return value.connection === "offline" && value;
      });
      assert.ok(status);
      assert.equal(status.active_operations, 0);
      assert.equal(JSON.stringify(status).includes("abr_device_"), false);
    } finally {
      await f.close();
    }
  },
);

test(
  "native client: operation limit, cancellation and revoked credentials fail closed",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      for (let i = 0; i < 8; i++) f.dispatch(`busy_${i}`, "command_execute", { command: "sleep 20" });
      await until(async () => (await f.cli("status")).active_operations === 8);
      f.dispatch("overflow", "files_list", { path: f.directory });
      assert.equal(((await f.result("overflow")).error as Frame).code, "device_busy");
      f.peer.send(JSON.stringify({ type: "cancel", connection_epoch: f.epoch, operation_ids: ["busy_0"] }));
      assert.equal((await f.result("busy_0")).status, "outcome_unknown");
      await f.cli("control", "stop");
      for (let i = 1; i < 8; i++) assert.equal((await f.result(`busy_${i}`)).status, "outcome_unknown");
      assert.equal((await f.cli("status")).active_operations, 0);
      f.reject = true;
      f.peer.terminate();
      await until(async () => (await f.cli("status")).connection === "revoked");
      assert.equal(
        (JSON.parse(await readFile(join(f.directory, "config.json"), "utf8")) as Frame).revoked,
        true,
      );
    } finally {
      await f.close();
    }
  },
);

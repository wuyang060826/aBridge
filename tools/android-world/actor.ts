/** Local controller for an isolated AndroidWorld emulator. The actor only receives a scoped MCP gateway. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "../../apps/server/src/server.js";
import { runCodexAgent } from "../bench/codex-agent.js";
import { createAgentGateway } from "../bench/gateway.js";
import suite from "./suite.json" with { type: "json" };

const [adb, serial, output, modelCatalog, avdName] = process.argv.slice(2);
if (
  !adb ||
  !serial ||
  !/^emulator-[0-9]+$/.test(serial) ||
  !output ||
  !modelCatalog ||
  (avdName !== "AndroidWorldAvd" && avdName !== "AndroidWorldAvdMarkor")
)
  throw Error("Expected ADB path, emulator serial, results directory, and model catalog");
const runDir = resolve(output);
const modelCatalogPath = await realpath(modelCatalog);
const hashCatalog = async () =>
  createHash("sha256")
    .update(await readFile(modelCatalogPath))
    .digest("hex");
const catalogSha256 = await hashCatalog();
const catalog = JSON.parse(await readFile(modelCatalogPath, "utf8")) as { models: { slug: string }[] };
if (!catalog.models.some((entry) => entry.slug === suite.model))
  throw Error("Catalog does not contain benchmark model");
await mkdir(runDir, { recursive: true, mode: 0o700 });
await chmod(runDir, 0o700);
const app = await createServer({ dbPath: resolve(runDir, "server.db"), port: 0 });
const tools = ["computer_observe", "computer_act"];
const instruction = [
  "Complete the AndroidWorld task in the currently open Android app using only aBridge computer_observe and computer_act.",
  "Start with computer_observe(desktop=true,screenshot=true). Use the UI tree and the screenshot together.",
  "Prefer the latest observation’s element_ref for click and long_press. Each action returns the updated UI elements by default. Reuse that observation and request a screenshot only when the UI tree is insufficient.",
  "Click is a tap. For an element with long_clickable=false, prefer visible selection controls. Android lists may reject simulated touch long presses. Use click_refs with element_refs for several independent clickable toggles on the same unchanged list, then verify the returned selection. Each step revalidates its target and reports applied refs.",
  "For local UI actions start with wait_after_ms=500, increasing it when the app is visibly loading. Scroll works with the latest UI observation.",
  "For typing, use the editable element_ref or click to focus first. type replaces the field. key supports back, home, enter, search and done.",
  "Check the returned state before sending another action. For edits, complete the app’s save flow and verify persistence by reopening or viewing the saved item. An editor displaying the new text alone does not establish persistence. Once the UI confirms completion, stop.",
].join(" ");

let removeReverse: (() => void) | undefined;
try {
  const url = await app.start();
  const user = await app.store.createUser("android-world-owner", randomUUID());
  const { device, key: deviceKey } = app.store.createDevice(
    user.id,
    "AndroidWorld emulator",
    ["screen", "input"],
    "computer",
  );
  const { key } = app.store.createAgentConnection(user.id, "AndroidWorld actor", {
    mode: "selected",
    devices: [{ device_id: device.id, capabilities: ["screen", "input"] }],
  });
  const adbCall = (args: string[], input?: string) =>
    execFileSync(adb, ["-s", serial, ...args], {
      input,
      timeout: 20000,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
  if (
    adbCall(["shell", "getprop", "ro.build.version.sdk"]).trim() !== String(suite.emulator.api) ||
    adbCall(["shell", "getprop", "ro.product.cpu.abi"]).trim() !== suite.emulator.arch ||
    !adbCall(["emu", "avd", "name"]).split(/\r?\n/).includes(avdName)
  )
    throw Error("Unexpected benchmark emulator profile");
  const pkg = "dev.abridge.android";
  const address = new URL(url);
  const port = "tcp:" + address.port;
  adbCall(["reverse", "--no-rebind", port, port]);
  removeReverse = () => {
    adbCall(["reverse", "--remove", port]);
  };
  const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  // Preserve the upstream service and explicitly re-enable ours after replacing bootstrap state.
  const enabled = adbCall(["shell", "settings", "get", "secure", "enabled_accessibility_services"]).trim();
  const component = `${pkg}/.DeviceService`;
  const existing = enabled === "null" ? [] : enabled.split(":").filter((v) => v && !v.startsWith(pkg + "/"));
  adbCall([
    "shell",
    "settings",
    "put",
    "secure",
    "enabled_accessibility_services",
    existing.length ? existing.join(":") : "null",
  ]);
  // Only the disposable debug APK accepts run-as. No credentials are passed on argv.
  adbCall(["shell", "am", "force-stop", pkg]);
  adbCall(["shell", "run-as", pkg, "mkdir", "-p", "shared_prefs"]);
  adbCall(
    ["shell", "-T", `run-as ${pkg} sh -c 'umask 077; cat > shared_prefs/device.xml'`],
    `<map><string name="url">${xml(address.origin)}</string><string name="key">${xml(deviceKey)}</string><boolean name="screen" value="true"/><boolean name="input" value="true"/><boolean name="paused" value="false"/></map>\n`,
  );
  adbCall(["shell", "am", "start", "-n", `${pkg}/.SettingsActivity`]);
  adbCall([
    "shell",
    "settings",
    "put",
    "secure",
    "enabled_accessibility_services",
    [...existing, component].join(":"),
  ]);
  adbCall(["shell", "settings", "put", "secure", "accessibility_enabled", "1"]);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const response = await fetch(url + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(35_000),
    });
    const body = (await response.json()) as {
      error?: unknown;
      result?: { isError?: boolean; content: { text?: string }[] };
    };
    const raw = body.result?.content[0]?.text;
    if (!response.ok || body.error || !raw || body.result?.isError)
      throw Error(`${tool} failed: ${raw ?? response.status}`);
    return JSON.parse(raw) as Record<string, unknown>;
  };
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const opened = await call("session_open", { device_id: device.id, capabilities: ["screen", "input"] });
      if (typeof opened.id === "string") {
        await call("session_close", { session_id: opened.id });
        ready = true;
        break;
      }
    } catch {
      /* Wait for the Android device to register. */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!ready) throw Error("Android device did not register with screen and input ready");
  process.stdout.write(JSON.stringify({ ready, catalogSha256 }) + "\n");

  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const episode = JSON.parse(line) as { task: string; seed: number; goal: string };
    if (
      !suite.tasks.includes(episode.task) ||
      !suite.seeds.includes(episode.seed) ||
      typeof episode.goal !== "string" ||
      !episode.goal
    )
      throw Error("Episode outside the fixed suite");
    const logDir = resolve(runDir, `${episode.task}-${episode.seed}`);
    await mkdir(logDir, { mode: 0o700 });
    const workDir = resolve(logDir, "actor");
    await mkdir(workDir, { mode: 0o700 });
    const opened = await call("session_open", { device_id: device.id, capabilities: ["screen", "input"] });
    if (typeof opened.id !== "string") throw Error("No valid Android session");
    const sessionId = opened.id;
    const abort = new AbortController();
    const gateway = await createAgentGateway({
      targetUrl: url,
      targetToken: key,
      sessionId,
      tools,
      maxToolCalls: suite.maxToolCalls,
      onBudgetExceeded: () => abort.abort(),
      toolCost: (tool, args) => {
        const action = args.action;
        if (
          tool !== "computer_act" ||
          !action ||
          typeof action !== "object" ||
          !("type" in action) ||
          action.type !== "click_refs" ||
          !("element_refs" in action) ||
          !Array.isArray(action.element_refs)
        )
          return 1;
        return Math.max(1, action.element_refs.length);
      },
    });
    const started = performance.now();
    let cleanup = false;
    try {
      const outcome = await runCodexAgent({
        workDir,
        logDir,
        serverUrl: new URL(gateway.url).origin,
        bearerToken: gateway.token,
        sessionId,
        taskPrompt: episode.goal,
        model: suite.model,
        modelCatalogPath,
        timeoutMs: suite.episodeLimitMs,
        signal: abort.signal,
        actor: { tools, instruction },
      });
      await gateway.close();
      await call("session_close", { session_id: sessionId });
      cleanup = true;
      if ((await hashCatalog()) !== catalogSha256) throw Error("Model catalog changed");
      const result = {
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        budgetExceeded: gateway.budgetExceeded,
        toolCalls: gateway.calls.length,
        actionUnits: gateway.actionUnits,
        toolViolations: outcome.toolViolations.length + gateway.violations.length,
        elapsedMs: Math.round(performance.now() - started),
        usage: outcome.usage,
        cleanup,
      };
      await writeFile(
        resolve(logDir, "actor.json"),
        JSON.stringify({ result, outcome, calls: gateway.calls }, null, 2),
        { mode: 0o600 },
      );
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally {
      await gateway.close();
      if (!cleanup) await call("session_close", { session_id: sessionId }).catch(() => undefined);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "AndroidWorld actor failed");
  process.exitCode = 1;
} finally {
  const keepAlive = setTimeout(() => process.exit(1), 15000);
  try {
    await app.close();
  } finally {
    clearTimeout(keepAlive);
    removeReverse?.();
  }
}

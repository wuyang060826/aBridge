/** Opt-in MiniWoB execution benchmark: HTTP MCP -> Server -> real unpacked extension -> Chrome. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createServer } from "../../apps/server/src/server.js";
import { launchBenchmarkChrome } from "./chrome.js";
import {
  policies,
  serveMiniwob,
  source,
  summarize,
  tasks,
  upstreamSuccess,
  type EpisodeResult,
} from "./miniwob.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const { values } = parseArgs({
  options: {
    episodes: { type: "string", default: "10" },
    chrome: { type: "string" },
    out: { type: "string" },
    "negative-controls": { type: "boolean" },
  },
});
const count = Number(values.episodes);
const negativeControls = values["negative-controls"] ?? false;
if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
  throw Error("--episodes must be an integer from 1 to 1000 per task");
const root = resolve(import.meta.dirname, "../..");
await mkdir(join(root, ".local/bench/runs"), { recursive: true });
const runDirectory = await mkdtemp(join(root, ".local/bench/runs/miniwob-"));
await writeFile(
  join(runDirectory, "run.json"),
  JSON.stringify({ startedAt: new Date().toISOString(), count }, null, 2),
);
console.log(`Benchmark evidence: ${runDirectory}`);
const fixture = await serveMiniwob(join(root, ".local/bench/cache", source.commit));
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let chrome: Awaited<ReturnType<typeof launchBenchmarkChrome>> | undefined;
let launchingChrome: ReturnType<typeof launchBenchmarkChrome> | undefined;
const results: EpisodeResult[] = [];
let mcpCalls = 0;
let interrupted = false;
let closing: Promise<void> | undefined;
function closeResources(): Promise<void> {
  closing ??= (async () => {
    const browser = chrome ?? (await launchingChrome?.catch(() => undefined));
    const closed = await Promise.allSettled([browser?.close(), server?.close(), fixture.close()]);
    const failed = closed.find((item) => item.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  })();
  return closing;
}
const interrupt = (code: number) => {
  interrupted = true;
  void closeResources().then(
    () => process.exit(code),
    () => process.exit(code),
  );
};
const sigint = () => interrupt(130),
  sigterm = () => interrupt(143);
process.once("SIGINT", sigint);
process.once("SIGTERM", sigterm);
try {
  server = await createServer({ dbPath: join(runDirectory, "server.db"), port: 0 });
  const url = await server.start();
  const user = await server.store.createUser("benchmark-owner", randomUUID());
  const device = server.store.createDevice(user.id, "Isolated benchmark browser", ["browser"], "browser");
  const { key } = server.store.createAgentConnection(user.id, "Benchmark MCP", {
    mode: "selected",
    devices: [{ device_id: device.device.id, capabilities: ["browser"] }],
  });
  const extensionPath = join(runDirectory, "extension");
  await cp(join(root, "dist/browser"), extensionPath, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  // Bootstrap only: pregrant the disposable local Server origin, not real account/site permissions.
  manifest.host_permissions = [url + "/*"];
  if (typeof manifest.key !== "string")
    throw Error("Development extension must contain its pinned public key");
  const extensionId = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  await writeFile(join(extensionPath, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (interrupted) throw Error("Benchmark interrupted");
  launchingChrome = launchBenchmarkChrome({
    executable: values.chrome,
    extensionPath,
    profilePath: join(runDirectory, "profile"),
    logPath: join(runDirectory, "chrome.log"),
  });
  chrome = await launchingChrome;
  if (interrupted) throw Error("Benchmark interrupted");
  const browser = chrome;
  const first = (await browser.targets()).find((target) => target.type === "page");
  if (!first) throw Error("Chrome did not create its bootstrap page");
  const bootstrap = await browser.connectTarget(first.id);
  let worker;
  for (let i = 0; i < 100; i++) {
    worker = (await browser.targets()).find(
      (target) =>
        target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/worker.js`,
    );
    if (worker) break;
    await delay(100);
  }
  if (!worker)
    throw Error("Extension worker not found; use Chrome for Testing/Chromium supporting --load-extension");
  // URL.origin is "null" for chrome-extension in Node; preserve the actual extension host.
  const popupUrl = `chrome-extension://${new URL(worker.url).host}/popup.html`;
  const popupTarget = await bootstrap.send<{ targetId: string }>("Target.createTarget", { url: popupUrl });
  await bootstrap.close();
  const popup = await browser.connectTarget(popupTarget.targetId);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await popup
      .evaluate<boolean>("typeof chrome !== 'undefined' && !!chrome.runtime?.id")
      .catch(() => false);
    if (ready) break;
    await delay(100);
  }
  if (!ready) {
    await writeFile(
      join(runDirectory, "bootstrap-failure.json"),
      JSON.stringify(
        {
          worker,
          targets: await browser.targets(),
          page: await popup
            .evaluate(
              "({url:location.href,title:document.title,body:document.body?.innerText,keys:typeof chrome === 'undefined'?[]:Object.keys(chrome)})",
            )
            .catch(String),
        },
        null,
        2,
      ),
    );
    throw Error("Extension popup not ready");
  }
  const bind = await popup.evaluate<unknown>(
    `chrome.runtime.sendMessage(${JSON.stringify({ type: "bind_token", server: url, device_key: device.key })})`,
  );
  if (!record(bind) || bind.ok !== true) throw Error("Disposable extension binding rejected");
  for (let i = 0; i < 150; i++) {
    const status = await popup.evaluate<unknown>("chrome.runtime.sendMessage({type:'status'})");
    if (record(status) && status.connected === true) {
      ready = true;
      break;
    }
    ready = false;
    await delay(100);
  }
  await popup.close();
  if (!ready) throw Error("Extension did not connect to the isolated Server");
  console.log(`Extension connected: ${browser.browserVersion}`);
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    mcpCalls++;
    const response = await fetch(url + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: mcpCalls,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) throw Error(`MCP HTTP ${response.status}`);
    const envelope: unknown = await response.json();
    if (!record(envelope) || !record(envelope.result) || !Array.isArray(envelope.result.content))
      throw Error("Invalid MCP response");
    const text = envelope.result.content.find(
      (item: unknown) => record(item) && item.type === "text" && typeof item.text === "string",
    ) as { text: string } | undefined;
    const value: unknown = text ? JSON.parse(text.text) : undefined;
    if (!record(value)) throw Error("Missing MCP text response");
    if (envelope.result.isError) throw Error(`MCP ${name}: ${JSON.stringify(value.error ?? value)}`);
    return value;
  }
  async function runCode(session: string, code: string) {
    let response = await call("browser_exec", {
      session_id: session,
      operation_id: randomUUID(),
      code,
      wait_seconds: 15,
      timeout_ms: 20_000,
    });
    const deadline = performance.now() + 25_000;
    while (response.status !== "executed") {
      if (
        !["accepted", "dispatched", "executing", "cancel_requested"].includes(String(response.status)) ||
        performance.now() > deadline
      )
        throw Error(`Browser operation ended: ${JSON.stringify(response)}`);
      response = await call("operation_status", { operation_id: response.operation_id, wait_seconds: 1 });
    }
    if (!record(response.result)) throw Error("Browser execution returned no result");
    return response.result;
  }
  const judgeCode = `return await page.evaluate(() => ({done: WOB_DONE_GLOBAL, rawReward: WOB_RAW_REWARD_GLOBAL, envReward: WOB_REWARD_GLOBAL}));`;
  for (let seed = 0; seed < count; seed++)
    for (const task of tasks) {
      const start = performance.now();
      const beforeCalls = mcpCalls;
      let session: string | undefined;
      const result: EpisodeResult = {
        task,
        seed,
        success: false,
        done: false,
        rawReward: null,
        envReward: null,
        solveMs: null,
        totalMs: 0,
        solveMcpCalls: 0,
        totalMcpCalls: 0,
        browserSteps: null,
        cleanup: false,
      };
      try {
        const opened = await call("session_open", { device_id: device.device.id, capabilities: ["browser"] });
        if (typeof opened.id !== "string") throw Error("Session ID missing");
        session = opened.id;
        const episodeUrl = `${fixture.url}/miniwob/${task}.html?bench_seed=${seed}`;
        await call("browser_open", { session_id: session, url: episodeUrl, screenshot: false });
        await runCode(
          session,
          `await page.evaluate((seed) => { Math.seedrandom(seed); core.setDataMode('test'); core.startEpisodeReal(); }, ${seed});`,
        );
        const beforeSolveCalls = mcpCalls;
        const solveStart = performance.now();
        try {
          const control =
            task === "click-test"
              ? "await page.wait({selector:'#sync-task-cover',state:'visible',timeout_ms:12000});"
              : "await page.locator('#tt').fill('ABRIDGE_INTENTIONALLY_WRONG_000'); await page.locator('#subbtn').click();";
          const solved = await runCode(session, negativeControls ? control : policies[task]);
          result.browserSteps = typeof solved.steps_completed === "number" ? solved.steps_completed : null;
        } finally {
          result.solveMs = performance.now() - solveStart;
          result.solveMcpCalls = mcpCalls - beforeSolveCalls;
        }
        const graded = (await runCode(session, judgeCode)).value;
        if (
          !record(graded) ||
          typeof graded.done !== "boolean" ||
          typeof graded.rawReward !== "number" ||
          typeof graded.envReward !== "number"
        )
          throw Error("Upstream grader did not return terminal fields");
        result.done = graded.done;
        result.rawReward = graded.rawReward;
        result.envReward = graded.envReward;
        result.success = upstreamSuccess(result);
      } catch (error) {
        // Every attempted episode remains in the denominator; failed work is never retried.
        result.error = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      } finally {
        if (session) {
          try {
            await call("session_close", { session_id: session });
            const cleanupDeadline = performance.now() + 10000;
            while (performance.now() < cleanupDeadline) {
              const remaining = cleanupDeadline - performance.now();
              let timeout: ReturnType<typeof setTimeout> | undefined;
              let targets;
              try {
                targets = await Promise.race([
                  browser.targets(),
                  new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(Error("Cleanup observation timed out")), remaining);
                  }),
                ]);
              } finally {
                clearTimeout(timeout);
              }
              if (
                !targets.some(
                  (target) => target.type === "page" && target.url.startsWith(fixture.url + "/miniwob/"),
                )
              ) {
                result.cleanup = true;
                break;
              }
              await delay(Math.min(50, Math.max(0, cleanupDeadline - performance.now())));
            }
          } catch {
            result.cleanup = false;
          }
        }
        result.totalMs = performance.now() - start;
        result.totalMcpCalls = mcpCalls - beforeCalls;
        results.push(result);
        await writeFile(join(runDirectory, "episodes.json"), JSON.stringify(results, null, 2) + "\n");
        console.log(
          `${task} seed=${seed} ${negativeControls ? (result.done && result.rawReward === -1 ? "REJECTED_AS_EXPECTED" : "CONTROL_FAILED") : result.success ? "PASS" : "FAIL"} solve_ms=${result.solveMs?.toFixed(1) ?? "n/a"} cleanup=${result.cleanup}`,
        );
      }
    }
  const fingerprints: Record<string, string> = {};
  for (const file of (await readdir(join(root, "tools/bench"))).sort())
    fingerprints[file] = createHash("sha256")
      .update(await readFile(join(root, "tools/bench", file)))
      .digest("hex");
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    productVersion: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version as string,
    productCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    benchmarkFiles: fingerprints,
    workerSha256: createHash("sha256")
      .update(await readFile(join(root, "dist/browser/worker.js")))
      .digest("hex"),
    upstream: source,
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      node: process.version,
      chrome: browser.browserVersion,
    },
    protocol: {
      mode: negativeControls
        ? "deterministic-visible-DOM-negative-controls"
        : "deterministic-visible-DOM-policy",
      expectedRawReward: negativeControls ? -1 : 1,
      chain: "HTTP MCP -> Server -> WebSocket -> actual unpacked extension -> Chrome CDP",
      seedType: "number",
      seeds: Array.from({ length: count }, (_, i) => i),
      taskLimitMs: 10_000,
      timing:
        "solveMs excludes navigation, initialization, grading and cleanup; totalMs includes all episode lifecycle",
      setup: "isolated profile; disposable Device Key; pregranted loopback Server host permission",
      model: null,
      cleanupObservationMs: 10000,
      retries: 0,
      warmupEpisodes: 0,
    },
    summary: summarize(results),
    episodes: results,
  };
  await writeFile(join(runDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (values.out) {
    const path = resolve(values.out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report.summary, null, 2));
  if (
    results.some(
      (result) =>
        !(negativeControls ? result.done && result.rawReward === -1 : result.success) || !result.cleanup,
    )
  )
    process.exitCode = 1;
} finally {
  try {
    await closeResources();
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}

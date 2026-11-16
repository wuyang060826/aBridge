/** Real, isolated browser benchmark bootstrap. No model, mock extension or process signal ownership. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../../apps/server/src/server.js";
import { launchBenchmarkChrome } from "./chrome.js";
import { serveMiniwob, type SourceManifest } from "./miniwob.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface BenchmarkEnvironment {
  url: string;
  token: string;
  deviceId: string;
  fixtureUrl: string;
  runDirectory: string;
  browserVersion: string;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  runCode(session: string, code: string): Promise<Record<string, unknown>>;
  targetUrls(): Promise<string[]>;
  close(): Promise<void>;
}

export async function createBenchmarkEnvironment(options: {
  manifest: SourceManifest;
  chromeExecutable?: string;
  signal?: AbortSignal;
}): Promise<BenchmarkEnvironment> {
  let stopped = false;
  function ensureActive() {
    options.signal?.throwIfAborted();
    if (stopped) throw Error("Benchmark environment closed");
  }
  ensureActive();
  const root = resolve(import.meta.dirname, "../..");
  await mkdir(join(root, ".local/bench/runs"), { recursive: true });
  ensureActive();
  const runDirectory = await mkdtemp(join(root, ".local/bench/runs/agent-"));
  await chmod(runDirectory, 0o700);
  ensureActive();
  let fixturePromise: ReturnType<typeof serveMiniwob> | undefined;
  let serverPromise: ReturnType<typeof createServer> | undefined;
  let serverStartPromise: Promise<string> | undefined;
  let launchingChrome: ReturnType<typeof launchBenchmarkChrome> | undefined;
  let closing: Promise<void> | undefined;
  let mcpCalls = 0;
  function close(): Promise<void> {
    stopped = true;
    closing ??= (async () => {
      options.signal?.removeEventListener("abort", abort);
      const results = await Promise.allSettled([
        launchingChrome?.then(
          (browser) => browser.close(),
          () => undefined,
        ),
        serverPromise?.then(
          async (server) => {
            await serverStartPromise?.catch(() => undefined);
            return server.close();
          },
          () => undefined,
        ),
        fixturePromise?.then(
          (fixture) => fixture.close(),
          () => undefined,
        ),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return closing;
  }
  function abort() {
    void close().catch(() => undefined);
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    ensureActive();
    fixturePromise = serveMiniwob(
      join(root, ".local/bench/cache", options.manifest.commit),
      options.manifest,
    );
    const fixture = await fixturePromise;
    ensureActive();
    serverPromise = createServer({ dbPath: join(runDirectory, "server.db"), port: 0 });
    const server = await serverPromise;
    ensureActive();
    serverStartPromise = server.start();
    const url = await serverStartPromise;
    ensureActive();
    const user = await server.store.createUser("benchmark-owner", randomUUID());
    const device = server.store.createDevice(user.id, "Isolated benchmark browser", ["browser"], "browser");
    const { key } = server.store.createGrant(user.id, "Benchmark MCP", {
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
    ensureActive();
    launchingChrome = launchBenchmarkChrome({
      executable: options.chromeExecutable,
      extensionPath,
      profilePath: join(runDirectory, "profile"),
      logPath: join(runDirectory, "chrome.log"),
    });
    const chrome = await launchingChrome;
    ensureActive();
    const browser = chrome;
    const first = (await browser.targets()).find((target) => target.type === "page");
    if (!first) throw Error("Chrome did not create its bootstrap page");
    const bootstrap = await browser.connectTarget(first.id);
    let worker;
    for (let i = 0; i < 100; i++) {
      ensureActive();
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
      ensureActive();
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
      ensureActive();
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
    async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      ensureActive();
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
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(40_000)])
          : AbortSignal.timeout(40_000),
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
        response = await call("command_status", { operation_id: response.operation_id, wait_seconds: 1 });
      }
      if (!record(response.result)) throw Error("Browser execution returned no result");
      return response.result;
    }
    ensureActive();
    return {
      url,
      token: key,
      deviceId: device.device.id,
      fixtureUrl: fixture.url,
      runDirectory,
      browserVersion: browser.browserVersion,
      call,
      runCode,
      async targetUrls() {
        ensureActive();
        return (await browser.targets())
          .filter((target) => target.type === "page")
          .map((target) => target.url);
      },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

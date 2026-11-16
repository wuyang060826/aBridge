import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const STARTUP_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 15_000;

export interface CdpClient {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T>(expression: string, options?: { awaitPromise?: boolean; userGesture?: boolean }): Promise<T>;
  close(): Promise<void>;
}

export interface BenchmarkTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function findExecutable(explicit?: string): Promise<string> {
  const configured = explicit ?? process.env.ABRIDGE_BENCH_CHROME;
  if (configured) {
    await access(configured, constants.X_OK);
    return configured;
  }
  const home = homedir();
  const cache =
    process.platform === "darwin"
      ? join(home, "Library/Caches/ms-playwright")
      : join(home, ".cache/ms-playwright");
  const candidates: string[] = [];
  for (const entry of (await readdir(cache).catch(() => [])).sort().reverse()) {
    if (!entry.startsWith("chromium-")) continue;
    for (const suffix of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
    ])
      candidates.push(join(cache, entry, suffix));
  }
  candidates.push(
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
  );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next installed binary. */
    }
  }
  throw new Error(
    "Chrome not found; set ABRIDGE_BENCH_CHROME to a Chrome for Testing or Chromium executable",
  );
}

async function connectCdp(endpoint: string): Promise<CdpClient> {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Benchmark CDP endpoint must use loopback WebSocket");
  }
  const socket = new WebSocket(url, { handshakeTimeout: COMMAND_TIMEOUT_MS });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const rejectPending = (error: Error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  socket.on("error", (error) => rejectPending(error));
  socket.on("close", () => rejectPending(new Error("CDP connection closed")));
  socket.on("message", (data) => {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!record(message) || typeof message.id !== "number") return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (record(message.error)) {
      item.reject(new Error(`CDP error: ${String(message.error.message ?? "unknown error")}`));
    } else item.resolve(message.result);
  });
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("CDP closed before connecting")));
  });
  const send = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolveResult, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error("CDP connection is not open"));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve: (value) => resolveResult(value as T), reject, timer });
      socket.send(JSON.stringify({ id, method, params: params ?? {} }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  return {
    send,
    async evaluate<T>(expression: string, options = {}): Promise<T> {
      const response = await send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          ...options,
        },
      );
      if (response.exceptionDetails) throw new Error("CDP evaluation threw an exception");
      return response.result?.value as T;
    },
    async close() {
      rejectPending(new Error("CDP connection closed"));
      socket.terminate();
    },
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

export async function launchBenchmarkChrome(options: {
  executable?: string;
  extensionPath: string;
  profilePath: string;
  logPath: string;
}): Promise<{
  browserVersion: string;
  targets(): Promise<BenchmarkTarget[]>;
  connectTarget(id: string): Promise<CdpClient>;
  close(): Promise<void>;
}> {
  const executable = await findExecutable(options.executable);
  const extensionPath = resolve(options.extensionPath);
  const profilePath = resolve(options.profilePath);
  await access(join(extensionPath, "manifest.json"));
  await mkdir(profilePath, { recursive: true, mode: 0o700 });
  if ((await readdir(profilePath)).length)
    throw new Error("Benchmark Chrome requires a new, empty profile directory");
  await chmod(profilePath, 0o700);
  await mkdir(dirname(resolve(options.logPath)), { recursive: true });
  const log = await open(options.logPath, "w", 0o600);
  await log.chmod(0o600);
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profilePath}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--password-store=basic",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", log.fd] },
  );
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  await log.close();
  const clients = new Set<CdpClient>();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([...clients].map((client) => client.close()));
    await stopChild(child);
  };
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let port: number | undefined;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Benchmark Chrome exited during startup; inspect its log");
      const activePort = await readFile(join(profilePath, "DevToolsActivePort"), "utf8").catch(() => "");
      const value = Number(activePort.split("\n")[0]);
      if (Number.isInteger(value) && value > 0 && value <= 65535) {
        port = value;
        break;
      }
      await delay(100);
    }
    if (!port) throw new Error("Benchmark Chrome startup timed out; inspect its log");
    const getJson = async (path: string): Promise<unknown> => {
      if (closed) throw new Error("Benchmark Chrome is closed");
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Chrome debugging endpoint returned HTTP ${response.status}`);
      return response.json();
    };
    const version = await getJson("/json/version");
    if (!record(version) || typeof version.Browser !== "string")
      throw new Error("Invalid Chrome version response");
    const targets = async (): Promise<BenchmarkTarget[]> => {
      const values = await getJson("/json/list");
      if (!Array.isArray(values)) throw new Error("Invalid Chrome targets response");
      return values.map((value: unknown) => {
        if (
          !record(value) ||
          typeof value.id !== "string" ||
          typeof value.type !== "string" ||
          typeof value.url !== "string"
        ) {
          throw new Error("Invalid Chrome target");
        }
        return {
          id: value.id,
          type: value.type,
          url: value.url,
          ...(typeof value.webSocketDebuggerUrl === "string"
            ? { webSocketDebuggerUrl: value.webSocketDebuggerUrl }
            : {}),
        };
      });
    };
    return {
      browserVersion: version.Browser,
      targets,
      async connectTarget(id) {
        const target = (await targets()).find((item) => item.id === id);
        if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no debugging WebSocket");
        const client = await connectCdp(target.webSocketDebuggerUrl);
        if (closed) {
          await client.close();
          throw new Error("Benchmark Chrome is closed");
        }
        clients.add(client);
        return client;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

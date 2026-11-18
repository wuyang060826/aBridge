/** Per-episode MCP boundary: no executable page code, cross-session access or hidden DOM reads. */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

const browserTools = new Set(["browser_observe", "browser_read", "browser_act", "browser_wait"]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const buffers: Buffer[] = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", error);
      request.off("aborted", aborted);
    };
    const error = () => {
      cleanup();
      reject(new BodyError(400, "Request interrupted"));
    };
    const aborted = error;
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        request.resume();
        reject(new BodyError(413, "Request body too large"));
      } else buffers.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown);
      } catch {
        reject(new BodyError(400, "Invalid JSON"));
      }
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", error);
    request.once("aborted", aborted);
  });
}
export async function createAgentGateway(options: {
  targetUrl: string;
  targetToken: string;
  sessionId: string;
  maxToolCalls: number;
  onBudgetExceeded?: () => void;
  tools?: readonly string[];
  toolCost?: (tool: string, args: Record<string, unknown>) => number;
}) {
  if (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 0)
    throw Error("Invalid tool budget");
  const allowedTools = options.tools ? new Set(options.tools) : browserTools;
  const target = new URL(options.targetUrl);
  if (target.pathname === "/") target.pathname = "/mcp";
  const token = randomBytes(32).toString("hex");
  const calls: { tool: string; args: Record<string, unknown>; status: number; elapsedMs: number }[] = [];
  const violations: string[] = [];
  const controllers = new Set<AbortController>();
  let attempts = 0,
    budgetExceeded = false;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      let id: unknown = null;
      let call: (typeof calls)[number] | undefined;
      const started = performance.now();
      const controller = new AbortController();
      controllers.add(controller);
      const abort = () => controller.abort();
      request.once("aborted", abort);
      const disconnected = () => {
        if (!response.writableFinished) abort();
      };
      response.once("close", disconnected);
      const json = (status: number, value: unknown) => {
        if (!response.destroyed)
          response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      };
      const reject = (message: string, status = 403) => {
        if (call) call.status = status;
        json(status, { jsonrpc: "2.0", id, error: { code: -32600, message } });
      };
      try {
        if (request.method !== "POST" || request.url !== "/mcp") {
          reject("Endpoint unavailable", 404);
          return;
        }
        if (request.headers.authorization !== `Bearer ${token}`) {
          reject("Unauthorized", 401);
          return;
        }
        const body = await readBody(request);
        if (!record(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
          reject("Invalid JSON-RPC request", 400);
          return;
        }
        id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
        if (body.method === "resources/list" || body.method === "prompts/list") {
          json(200, {
            jsonrpc: "2.0",
            id,
            result: { [body.method === "resources/list" ? "resources" : "prompts"]: [] },
          });
          return;
        }
        if (body.method === "tools/call") {
          const params = record(body.params) ? body.params : {};
          const tool = typeof params.name === "string" ? params.name : "<invalid>";
          const args = record(params.arguments) ? params.arguments : {};
          call = { tool, args, status: 0, elapsedMs: 0 };
          calls.push(call);
          const cost = options.toolCost?.(tool, args) ?? 1;
          attempts += Number.isSafeInteger(cost) && cost > 0 ? cost : 1;
          if (attempts > options.maxToolCalls) {
            if (!budgetExceeded) {
              budgetExceeded = true;
              try {
                options.onBudgetExceeded?.();
              } catch {
                /* Budget remains enforced if notification fails. */
              }
            }
            reject("Tool budget exceeded", 429);
            return;
          }
          if (!allowedTools.has(tool)) {
            violations.push("Tool outside episode allowlist");
            reject("Tool unavailable");
            return;
          }
          if (args.session_id !== options.sessionId) {
            violations.push("Session outside episode scope");
            reject("Session unavailable");
            return;
          }
          if (
            tool === "browser_read" &&
            ((args.selector !== undefined && args.selector !== "body") ||
              Object.hasOwn(args, "frame_selector"))
          ) {
            violations.push("Read outside visible document scope");
            reject("Read scope unavailable");
            return;
          }
        } else if (!["initialize", "ping", "notifications/initialized", "tools/list"].includes(body.method)) {
          violations.push("Method outside episode allowlist");
          reject("Method unavailable");
          return;
        }
        const upstream = await fetch(target, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.targetToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
          redirect: "error",
        });
        let bytes = Buffer.from(await upstream.arrayBuffer());
        if (body.method === "tools/list" && upstream.ok && bytes.length) {
          const listing: unknown = JSON.parse(bytes.toString("utf8"));
          if (!record(listing) || !record(listing.result) || !Array.isArray(listing.result.tools))
            throw Error("Invalid tool list");
          listing.result.tools = listing.result.tools
            .filter((tool: unknown) => record(tool) && allowedTools.has(String(tool.name)))
            .map((tool: Record<string, unknown>) => {
              if (tool.name !== "browser_read") return tool;
              if (!record(tool.inputSchema) || !record(tool.inputSchema.properties))
                throw Error("Invalid read schema");
              const properties = { ...tool.inputSchema.properties };
              delete properties.frame_selector;
              properties.selector = { type: "string", enum: ["body"] };
              return {
                ...tool,
                inputSchema: {
                  ...tool.inputSchema,
                  properties,
                  ...(Array.isArray(tool.inputSchema.required)
                    ? {
                        required: tool.inputSchema.required.filter(
                          (key: unknown) => key !== "frame_selector",
                        ),
                      }
                    : {}),
                },
              };
            });
          bytes = Buffer.from(JSON.stringify(listing));
        }
        if (call) call.status = upstream.status;
        if (!response.destroyed) {
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(bytes);
        }
      } catch (error) {
        reject(
          error instanceof BodyError ? error.message : "Gateway request failed",
          error instanceof BodyError ? error.status : 502,
        );
      } finally {
        if (call) call.elapsedMs = performance.now() - started;
        request.off("aborted", abort);
        response.off("close", disconnected);
        controllers.delete(controller);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Gateway failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    calls,
    violations,
    get actionUnits() {
      return attempts;
    },
    get budgetExceeded() {
      return budgetExceeded;
    },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}

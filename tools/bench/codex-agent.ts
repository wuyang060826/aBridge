import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

interface AgentUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
}

interface AgentTranscript {
  usage: AgentUsage | null;
  mcpCalls: number;
  toolViolations: string[];
  finalText: string;
  calls: { tool: string; arguments: unknown; status: string }[];
  error?: string;
}

const allowedTools = new Set(["browser_observe", "browser_read", "browser_act", "browser_wait"]);
const passiveItems = new Set(["agent_message", "reasoning", "plan", "todo_list"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Parse CLI JSONL only; never executes commands or contacts a model. */
export function parseCodexAgentLog(jsonl: string): AgentTranscript {
  const result: AgentTranscript = { usage: null, mcpCalls: 0, toolViolations: [], finalText: "", calls: [] };
  const calls = new Set<string>();
  const callIndexes = new Map<string, number>();
  const violations = new Set<string>();
  let lineNumber = 0;
  for (const line of jsonl.split("\n")) {
    lineNumber++;
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      violations.add(`Unparseable CLI JSONL at line ${lineNumber}`);
      continue;
    }
    if (!record(event)) {
      violations.add(`Invalid CLI event at line ${lineNumber}`);
      continue;
    }
    if (event.type === "turn.completed") {
      const usage = event.usage;
      result.usage =
        record(usage) &&
        tokenCount(usage.input_tokens) &&
        tokenCount(usage.cached_input_tokens) &&
        tokenCount(usage.output_tokens)
          ? {
              inputTokens: usage.input_tokens,
              cachedInputTokens: usage.cached_input_tokens,
              outputTokens: usage.output_tokens,
              reasoningTokens: tokenCount(usage.reasoning_output_tokens)
                ? usage.reasoning_output_tokens
                : tokenCount(usage.reasoning_tokens)
                  ? usage.reasoning_tokens
                  : null,
            }
          : null;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const failure = record(event.error) ? event.error.message : event.message;
      result.error = typeof failure === "string" ? failure : String(event.type);
    }
    const item = record(event.item)
      ? event.item
      : ["mcp_tool_call", "tool_call"].includes(String(event.type))
        ? event
        : undefined;
    if (!item) continue;
    if (typeof item.type !== "string") {
      violations.add(`CLI item missing type at line ${lineNumber}`);
      continue;
    }
    if (item.type === "agent_message" && event.type === "item.completed" && typeof item.text === "string") {
      result.finalText = item.text;
    }
    if (passiveItems.has(item.type)) continue;
    // Fail closed for new item kinds: a future executable tool must be reviewed explicitly.
    const id = typeof item.id === "string" ? item.id : `line-${lineNumber}`;
    const functionName = record(item.function) ? item.function.name : undefined;
    const rawName = item.tool ?? item.tool_name ?? item.name ?? functionName;
    let server = typeof item.server === "string" ? item.server : undefined;
    let tool = typeof rawName === "string" ? rawName : undefined;
    const qualified = tool?.match(/^mcp__([^_]+)__(.+)$/);
    if (qualified) {
      server ??= qualified[1];
      tool = qualified[2];
    }
    const isMcp = item.type === "mcp_tool_call" || server !== undefined || Boolean(qualified);
    if (isMcp && !calls.has(id)) {
      calls.add(id);
      result.mcpCalls++;
    }
    if (["mcp_tool_call", "tool_call"].includes(item.type)) {
      const call = {
        tool: server && tool ? `${server}/${tool}` : (tool ?? item.type),
        arguments: item.arguments ?? item.args ?? (record(item.function) ? item.function.arguments : null),
        status: typeof item.status === "string" ? item.status : String(event.type),
      };
      const index = callIndexes.get(id);
      if (index === undefined) {
        callIndexes.set(id, result.calls.length);
        result.calls.push(call);
      } else {
        if (call.arguments === undefined || call.arguments === null)
          call.arguments = result.calls[index]!.arguments;
        result.calls[index] = call;
      }
    }
    if (
      !["mcp_tool_call", "tool_call"].includes(item.type) ||
      server !== "abridge" ||
      !tool ||
      !allowedTools.has(tool)
    ) {
      // Names only: never copy tool arguments, results, prompts or environment into audit messages.
      violations.add(`Disallowed tool item ${id}: ${item.type} ${server ?? "unknown"}/${tool ?? "unknown"}`);
    }
  }
  result.toolViolations = [...violations];
  return result;
}

export async function runCodexAgent(options: {
  workDir: string;
  logDir: string;
  serverUrl: string;
  bearerToken: string;
  sessionId: string;
  taskPrompt: string;
  model: string;
  modelCatalogPath?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AgentTranscript & { exitCode: number | null; timedOut: boolean }> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)
    throw Error("Codex timeoutMs must be a positive integer within the Node timer range");
  await mkdir(options.logDir, { recursive: true, mode: 0o700 });
  await chmod(options.logDir, 0o700);
  const stdoutPath = join(options.logDir, "codex.jsonl");
  const stdout = await open(stdoutPath, "wx", 0o600);
  let stderr;
  try {
    stderr = await open(join(options.logDir, "codex.stderr.log"), "wx", 0o600);
  } catch (error) {
    await stdout.close();
    throw error;
  }
  const environment: NodeJS.ProcessEnv = { ...process.env, ABRIDGE_BENCH_AGENT_KEY: options.bearerToken };
  delete environment.CODEX_THREAD_ID;
  const settings = [
    "features.shell_tool=false",
    "features.apps=false",
    "features.multi_agent=false",
    'web_search="disabled"',
    "project_doc_max_bytes=0",
    "plugins={}",
    'approval_policy="never"',
    'model_reasoning_effort="medium"',
    `mcp_servers={abridge={url=${JSON.stringify(options.serverUrl.replace(/\/$/, "") + "/mcp")},bearer_token_env_var="ABRIDGE_BENCH_AGENT_KEY",enabled_tools=["browser_observe","browser_read","browser_act","browser_wait"],required=true,default_tools_approval_mode="approve",tools={browser_observe={approval_mode="approve"},browser_read={approval_mode="approve"},browser_act={approval_mode="approve"},browser_wait={approval_mode="approve"}}}}`,
  ];
  if (options.modelCatalogPath)
    settings.push(`model_catalog_json=${JSON.stringify(options.modelCatalogPath)}`);
  // The prompt contains the task and opaque session ID only; grading implementation is not provided.
  const prompt = [
    "Complete the browser task using only the abridge browser_observe, browser_read, browser_act and browser_wait tools.",
    `Use the already-open browser session_id ${JSON.stringify(options.sessionId)}.`,
    "Observe the page before acting. Request screenshots when needed. Do not use shell, files, network, other tools, browser_exec or page evaluation.",
    "Do not navigate away from the assigned task or inspect grader implementation. Stop when the visible task is complete and give a concise final response.",
    options.taskPrompt,
  ].join("\n\n");
  let timedOut = false;
  let aborted = false;
  let infraError: Error | undefined;
  let exitCode: number | null = null;
  try {
    if (options.signal?.aborted)
      return {
        usage: null,
        mcpCalls: 0,
        toolViolations: [],
        finalText: "",
        calls: [],
        error: "Codex agent aborted before launch",
        exitCode: null,
        timedOut: false,
      };
    const child = spawn(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--json",
        "--skip-git-repo-check",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--cd",
        options.workDir,
        "--model",
        options.model,
        ...settings.flatMap((setting) => ["-c", setting]),
        "-",
      ],
      { cwd: options.workDir, env: environment, stdio: ["pipe", stdout.fd, stderr.fd] },
    );
    child.stdin?.on("error", () => {
      // EPIPE is expected if startup fails; close/error supplies the authoritative outcome.
    });
    child.stdin?.end(prompt);
    exitCode = await new Promise<number | null>((done) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3_000);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      const abort = () => {
        aborted = true;
        clearTimeout(timeout);
        terminate();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once("error", (error) => {
        infraError = error;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        done(code);
      });
    });
  } catch (error) {
    infraError = error instanceof Error ? error : Error(String(error));
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  const parsed = parseCodexAgentLog(await readFile(stdoutPath, "utf8"));
  if (infraError) {
    parsed.usage = null;
    parsed.finalText = `Infrastructure error: Codex process could not run (${"code" in infraError ? String(infraError.code) : infraError.name})`;
    parsed.error = parsed.finalText;
  }
  for (const secret of [options.bearerToken, options.serverUrl]) {
    if (!secret) continue;
    parsed.finalText = parsed.finalText.replaceAll(secret, "[redacted]");
    if (parsed.error) parsed.error = parsed.error.replaceAll(secret, "[redacted]");
  }
  parsed.finalText = parsed.finalText.replace(
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s)"']*/g,
    "[private endpoint]",
  );
  if (timedOut) parsed.error ??= "Codex agent exceeded its wall-clock timeout";
  if (aborted) parsed.error = "Codex agent aborted by suite signal";
  return { ...parsed, exitCode, timedOut };
}

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexAgentLog, runCodexAgent } from "../bench/codex-agent.js";

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

test("An already-aborted suite never launches Codex and is distinct from timeout", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "abridge-agent-abort-"));
  try {
    const result = await runCodexAgent({
      workDir,
      logDir: join(workDir, "logs"),
      serverUrl: "http://127.0.0.1:1",
      bearerToken: "fictional-test-key",
      sessionId: "fictional-test-session",
      taskPrompt: "Fixture task only.",
      model: "unused-model-not-called",
      timeoutMs: 1000,
      signal: AbortSignal.abort(),
    });
    assert.match(result.error ?? "", /aborted before launch/);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.usage, null);
    assert.deepEqual(result.calls, []);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("Codex transcript counts each MCP call once, retains arguments and takes final exact usage", () => {
  const item = {
    id: "call-1",
    type: "mcp_tool_call",
    server: "abridge",
    tool: "browser_observe",
    arguments: { session_id: "fixture-session", screenshot: true },
    status: "in_progress",
  };
  const result = parseCodexAgentLog(
    jsonl(
      { type: "item.started", item },
      { type: "item.completed", item: { ...item, arguments: undefined, status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } },
      {
        type: "turn.completed",
        usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 7 },
      },
      { type: "item.completed", item: { type: "agent_message", text: "Completed the visible task." } },
    ),
  );
  assert.equal(result.mcpCalls, 1);
  assert.deepEqual(result.toolViolations, []);
  assert.deepEqual(result.usage, {
    inputTokens: 30,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 7,
  });
  assert.deepEqual(result.calls, [
    {
      tool: "abridge/browser_observe",
      arguments: { session_id: "fixture-session", screenshot: true },
      status: "completed",
    },
  ]);
  assert.equal(result.finalText, "Completed the visible task.");
});

test("Codex audit rejects forbidden and failed tools, including non-MCP executable items", () => {
  const result = parseCodexAgentLog(
    jsonl(
      { type: "item.completed", item: { id: "a", type: "command_execution", status: "failed" } },
      {
        type: "item.completed",
        item: { id: "b", type: "mcp_tool_call", server: "abridge", tool: "browser_exec", status: "failed" },
      },
      {
        type: "item.completed",
        item: { id: "c", type: "tool_call", name: "mcp__other__browser_read", status: "failed" },
      },
      {
        type: "item.completed",
        item: { id: "d", type: "tool_call", name: "mcp__abridge__browser_act", status: "completed" },
      },
      { type: "item.completed", item: { id: "e", type: "web_search" } },
    ),
  );
  assert.equal(result.mcpCalls, 3);
  assert.equal(result.toolViolations.length, 4);
  assert.equal(result.usage, null);
});

test("Missing usage stays unknown; absent reasoning stays null and failed turns retain error", () => {
  assert.equal(parseCodexAgentLog("").usage, null);
  const result = parseCodexAgentLog(
    jsonl(
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3 } },
      { type: "turn.failed", error: { message: "Fixture provider unavailable" } },
    ),
  );
  assert.equal(result.usage?.reasoningTokens, null);
  assert.equal(result.error, "Fixture provider unavailable");
  const invalid = parseCodexAgentLog(
    jsonl({ type: "turn.completed", usage: { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 } }),
  );
  assert.equal(invalid.usage, null);
  assert.equal(parseCodexAgentLog("not-json").toolViolations.length, 1);
});

test("CLI message-only error items preserve diagnostics without claiming tool execution", () => {
  const message = "Codex could not update marketplace fixture: git ls-remote timed out after 30s";
  const result = parseCodexAgentLog(
    jsonl(
      { type: "item.completed", item: { id: "diagnostic-1", type: "error", message } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3 } },
      { type: "item.completed", item: { type: "agent_message", text: "Completed the visible task." } },
    ),
  );
  assert.deepEqual(result.diagnostics, [message]);
  assert.deepEqual(result.toolViolations, []);
  assert.deepEqual(result.calls, []);
  assert.equal(result.mcpCalls, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.usage?.inputTokens, 10);
  assert.equal(result.finalText, "Completed the visible task.");
});

test("error-shaped executable or unknown items still fail closed", () => {
  const variants = [
    { tool: "browser_exec" },
    { tool_name: "browser_exec" },
    { name: "mcp__abridge__browser_exec" },
    { server: "abridge" },
    { function: { name: "browser_exec" } },
    { command: "fixture executable" },
    { arguments: {} },
    { tool: null },
    { unknown_metadata: true },
  ];
  for (const fields of variants) {
    const result = parseCodexAgentLog(
      jsonl({ type: "item.completed", item: { type: "error", message: "Fixture diagnostic", ...fields } }),
    );
    assert.equal(result.toolViolations.length, 1, JSON.stringify(fields));
    assert.deepEqual(result.diagnostics, []);
  }
  assert.equal(
    parseCodexAgentLog(jsonl({ type: "item.completed", item: { type: "error" } })).toolViolations.length,
    1,
  );
  assert.equal(
    parseCodexAgentLog(
      jsonl({ type: "item.completed", item: { type: "future_tool", message: "Fixture diagnostic" } }),
    ).toolViolations.length,
    1,
  );
});

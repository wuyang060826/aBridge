import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAgent, type AgentEpisode } from "../bench/agent-metrics.js";
const episode = (patch: Partial<AgentEpisode> = {}): AgentEpisode => ({
  task: "task",
  seed: 0,
  success: true,
  businessSuccess: true,
  done: true,
  rawReward: 1,
  envReward: 0.5,
  officialLimitMs: 10000,
  elapsedMs: 100,
  toolCalls: 2,
  usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10, reasoningTokens: null },
  exitCode: 0,
  timedOut: false,
  budgetExceeded: false,
  toolViolations: 0,
  cleanup: true,
  failure: null,
  ...patch,
});
test("agent metrics retain failed and unstarted tasks and distinguish unknown from zero usage", () => {
  const row = summarizeAgent(
    [
      episode(),
      episode({
        seed: 1,
        success: false,
        businessSuccess: false,
        done: false,
        rawReward: 0,
        elapsedMs: 180000,
        usage: null,
        timedOut: true,
        failure: "time_budget",
      }),
      episode({
        seed: 2,
        success: false,
        businessSuccess: false,
        elapsedMs: null,
        usage: null,
        failure: "setup_or_grading_error",
      }),
    ],
    ["task"],
  )[0]!;
  assert.equal(row.episodes, 3);
  assert.equal(row.succeeded, 1);
  assert.equal(row.timedEpisodes, 2);
  assert.equal(row.agentP50Ms, 90050);
  assert.equal(row.agentP95Ms, 180000);
  assert.equal(row.usageEpisodes, 1);
  assert.equal(row.knownInputTokens, 100);
  assert.equal(row.knownOutputTokens, 10);
  assert.deepEqual(row.failures, { time_budget: 1, setup_or_grading_error: 1 });
});
test("agent metrics report protocol violations separately from business completion", () => {
  const row = summarizeAgent(
    [episode({ success: false, toolViolations: 1, failure: "tool_violation" })],
    ["task", "missing"],
  );
  assert.equal(row[0]!.succeeded, 0);
  assert.equal(row[0]!.businessSucceeded, 1);
  assert.equal(row[0]!.violatingEpisodes, 1);
  assert.equal(row[1]!.agentP50Ms, null);
  assert.equal(row[1]!.episodes, 0);
});

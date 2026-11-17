import test from "node:test";
import assert from "node:assert/strict";
import { summarize, upstreamSuccess, type EpisodeResult } from "../bench/miniwob.js";

const episode = (changes: Partial<EpisodeResult> = {}): EpisodeResult => ({
  task: "click-test",
  seed: 0,
  success: true,
  done: true,
  rawReward: 1,
  envReward: 0.5,
  solveMs: 100,
  totalMs: 200,
  solveMcpCalls: 1,
  totalMcpCalls: 6,
  browserSteps: 1,
  cleanup: true,
  ...changes,
});
test("MiniWoB success requires a terminal correct raw result, independently of time-weighted reward", () => {
  assert.equal(upstreamSuccess({ done: true, rawReward: 1 }), true);
  assert.equal(upstreamSuccess({ done: false, rawReward: 1 }), false);
  assert.equal(upstreamSuccess({ done: true, rawReward: -1 }), false);
  assert.equal(upstreamSuccess({ done: false, rawReward: null }), false);
});
test("benchmark keeps failed setup and failed solver episodes in success and timing denominators", () => {
  const summary = summarize([
    episode(),
    episode({
      seed: 1,
      success: false,
      done: false,
      rawReward: null,
      solveMs: null,
      browserSteps: null,
      solveMcpCalls: 0,
      cleanup: false,
    }),
    episode({
      seed: 2,
      success: false,
      done: true,
      rawReward: -1,
      solveMs: 900,
      browserSteps: null,
      solveMcpCalls: 2,
    }),
    episode({ seed: 3, solveMs: 300 }),
  ])[0]!;
  assert.equal(summary.episodes, 4);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.timedEpisodes, 3);
  assert.equal(summary.solveP50Ms, 300);
  assert.equal(summary.solveP95Ms, 900);
  assert.equal(summary.solveMcpCalls, 4);
  assert.equal(summary.unknownStepEpisodes, 2);
  assert.equal(summary.cleaned, 3);
});
test("benchmark defines even-sample median, nearest-rank P95 and empty-task output", () => {
  const summary = summarize([episode({ solveMs: 10 }), episode({ solveMs: 30 })]);
  assert.equal(summary[0]!.solveP50Ms, 20);
  assert.equal(summary[0]!.solveP95Ms, 30);
  assert.equal(summary[1]!.episodes, 0);
  assert.equal(summary[1]!.solveP50Ms, null);
  assert.equal(summary[1]!.solveP95Ms, null);
});

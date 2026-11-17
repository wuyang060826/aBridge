/** Reporting arithmetic for the real-agent suite; failures and unknown usage remain explicit. */
export interface AgentEpisode {
  task: string;
  seed: number;
  success: boolean;
  businessSuccess: boolean;
  done: boolean;
  rawReward: number | null;
  envReward: number | null;
  officialLimitMs: number | null;
  elapsedMs: number | null;
  toolCalls: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number | null;
  } | null;
  exitCode: number | null;
  timedOut: boolean;
  budgetExceeded: boolean;
  toolViolations: number;
  cleanup: boolean;
  failure: string | null;
}
export function summarizeAgent(episodes: AgentEpisode[], tasks: string[]) {
  return tasks.map((task) => {
    const entries = episodes.filter((e) => e.task === task);
    const times = entries.flatMap((e) => (e.elapsedMs === null ? [] : [e.elapsedMs])).sort((a, b) => a - b);
    const known = entries.flatMap((e) => (e.usage ? [e.usage] : []));
    const failures: Record<string, number> = {};
    for (const entry of entries)
      if (entry.failure) failures[entry.failure] = (failures[entry.failure] ?? 0) + 1;
    return {
      task,
      episodes: entries.length,
      succeeded: entries.filter((e) => e.success).length,
      businessSucceeded: entries.filter((e) => e.businessSuccess).length,
      timedEpisodes: times.length,
      agentP50Ms: times.length
        ? (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2
        : null,
      agentP95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1]! : null,
      toolCalls: entries.reduce((n, e) => n + e.toolCalls, 0),
      usageEpisodes: known.length,
      knownInputTokens: known.reduce((n, u) => n + u.inputTokens, 0),
      knownCachedInputTokens: known.reduce((n, u) => n + u.cachedInputTokens, 0),
      knownOutputTokens: known.reduce((n, u) => n + u.outputTokens, 0),
      cleaned: entries.filter((e) => e.cleanup).length,
      violatingEpisodes: entries.filter((e) => e.toolViolations > 0).length,
      failures,
    };
  });
}

/** Generate the README from recorded real-agent outcomes; never runs a model or browser. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { format as prettier, resolveConfig } from "prettier";
import suite from "./bench/agent-suite.json" with { type: "json" };
import manifest from "./bench/miniwob-agent-source.json" with { type: "json" };
import { summarizeAgent, type AgentEpisode } from "./bench/agent-metrics.js";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { check: { type: "boolean" } } });
const snapshotPath = resolve(root, "docs/benchmarks/miniwob-agent-results.json");
const snapshotText = await readFile(snapshotPath, "utf8");
const snapshot = JSON.parse(snapshotText) as {
  schemaVersion: number;
  recordedAt: string;
  upstream: { commit: string };
  environment: { cpu: string; platform: string; arch: string; chrome: string; node: string; codex: string };
  protocol: typeof suite & { mode: string; costUsd: null; retries: number };
  episodes: AgentEpisode[];
};
if (
  snapshot.schemaVersion !== 1 ||
  snapshot.upstream.commit !== manifest.commit ||
  snapshot.protocol.mode !== "real-agent-public-task-subset" ||
  snapshot.protocol.costUsd !== null ||
  snapshot.protocol.retries !== 0 ||
  !Array.isArray(snapshot.episodes)
)
  throw Error("Unsupported agent snapshot");
for (const key of Object.keys(suite) as (keyof typeof suite)[])
  if (JSON.stringify(snapshot.protocol[key]) !== JSON.stringify(suite[key]))
    throw Error(`Protocol mismatch: ${key}`);
const seen = new Set<string>();
for (const e of snapshot.episodes) {
  if (!e || typeof e !== "object") throw Error("Invalid episode");
  for (const n of [e.rawReward, e.envReward, e.officialLimitMs])
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n))) throw Error("Invalid grader metric");
  if (e.usage !== null && (typeof e.usage !== "object" || Array.isArray(e.usage)))
    throw Error("Invalid usage");
  if (e.failure !== null && typeof e.failure !== "string") throw Error("Invalid failure reason");
  const id = `${e.task}:${e.seed}`;
  if (!suite.tasks.includes(e.task) || !suite.seeds.includes(e.seed) || seen.has(id))
    throw Error("Unexpected/duplicate episode");
  seen.add(id);
  for (const key of ["success", "businessSuccess", "done", "timedOut", "budgetExceeded", "cleanup"] as const)
    if (typeof e[key] !== "boolean") throw Error(`Invalid outcome: ${key}`);
  for (const n of [e.toolCalls, e.toolViolations, ...(e.elapsedMs === null ? [] : [e.elapsedMs])])
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw Error("Invalid episode metric");
  if (
    e.businessSuccess !== (e.done && e.rawReward === 1) ||
    e.success !==
      (e.businessSuccess && e.exitCode === 0 && !e.timedOut && !e.budgetExceeded && e.toolViolations === 0) ||
    e.success !== (e.failure === null)
  )
    throw Error("Inconsistent outcome");
  if (e.usage) {
    const reasoning = e.usage.reasoningTokens;
    if (reasoning !== null && (!Number.isSafeInteger(reasoning) || reasoning < 0))
      throw Error("Invalid reasoning count");
    for (const n of [e.usage.inputTokens, e.usage.cachedInputTokens, e.usage.outputTokens])
      if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid token count");
    if (e.usage.cachedInputTokens > e.usage.inputTokens) throw Error("Invalid cached token count");
  }
}
if (seen.size !== suite.tasks.length * suite.seeds.length) throw Error("Incomplete suite");
const rows = summarizeAgent(snapshot.episodes, suite.tasks);
const total = summarizeAgent(
  snapshot.episodes.map((e) => ({ ...e, task: "all" })),
  ["all"],
)[0]!;
const env = snapshot.environment;
const fmt = (n: number | null) => (n === null ? "—" : (n / 1000).toFixed(1));
const content = [
  "<!-- benchmark:miniwob:start -->",
  "",
  `真实 **${suite.requestedModel}（${suite.reasoningEffort}）Agent** 通过 aBridge 完成公开 MiniWoB++ 任务：**${total.succeeded}/${total.episodes}（${((100 * total.succeeded) / total.episodes).toFixed(1)}%）**。任务、种子和预算在跑分前冻结，无重试，全部结果保留。`,
  "",
  "| 任务 | 成功 / 次数 | Agent P50（秒） | 工具调用总数 | 已知输入 / 输出 tokens | 用量覆盖 |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| \`${r.task}\` | ${r.succeeded}/${r.episodes} | ${fmt(r.agentP50Ms)} | ${r.toolCalls} | ${r.knownInputTokens} / ${r.knownOutputTokens} | ${r.usageEpisodes}/${r.episodes} |`,
  ),
  "",
  `每例限 ${suite.episodeLimitMs / 1000} 秒 / ${suite.maxToolCalls} 次工具调用，并发 ${suite.concurrency}；仅开放观察、读取、操作、等待，支持 DOM 与截图，不开放 JS 执行、源码直接读取或判分接口。P50 包含 CLI 启动和模型调用，已启动的失败也计时。表中 token 为已知样本合计（输入含缓存），超时未返回用量视为未知，不能按 0 计费；CLI 不提供实际美元账单。`,
  "",
  `失败分类：${
    Object.entries(total.failures)
      .map(([k, v]) => k + " × " + v)
      .join("；") || "无"
  }。用量覆盖 ${total.usageEpisodes}/${total.episodes}；会话清理 ${total.cleaned}/${total.episodes}。`,
  "",
  `环境：${env.cpu} / ${env.platform} ${env.arch} / ${env.chrome} / Node ${env.node} / ${env.codex}；记录时间 ${snapshot.recordedAt}。`,
  "",
  "这是 **6 类任务、每类 2 个种子的小样本适配子集**，原始任务限时统一延长至 180 秒，不是官方榜单成绩，也不能单独证明 aBridge 优于其他工具或覆盖 macOS App。固定策略的 30/30 仅作为执行链冒烟历史数据，与 Agent 分数分开。[方法与限制](docs/benchmarks/miniwob.md) · [逐次实测数据](docs/benchmarks/miniwob-agent-results.json)。",
  "",
  "```sh",
  "npm run benchmark:miniwob",
  "```",
  "<!-- benchmark:miniwob:end -->",
].join("\n");
const path = resolve(root, "README.md");
const original = await readFile(path, "utf8");
const block = /<!-- benchmark:miniwob:start -->[\s\S]*?<!-- benchmark:miniwob:end -->/;
if (!block.test(original)) throw Error("README benchmark markers missing");
const updated = await prettier(original.replace(block, content), {
  ...(await resolveConfig(path)),
  filepath: path,
});
if (values.check) {
  if (updated !== original) throw Error("README benchmark table is stale; run npm run benchmark:report");
  console.log(`Verified README against ${snapshot.episodes.length} real-agent episodes`);
} else {
  await writeFile(
    snapshotPath,
    await prettier(snapshotText, { ...(await resolveConfig(snapshotPath)), filepath: snapshotPath }),
  );
  await writeFile(path, updated);
}

/** Pinned upstream tasks and a visible-DOM policy; no model or hidden answer access. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import manifest from "./miniwob-source.json" with { type: "json" };

export const source = manifest;
export interface SourceManifest {
  repository: string;
  commit: string;
  files: Record<string, string>;
}
export const tasks = ["click-test", "enter-text", "read-table"] as const;
export type Task = (typeof tasks)[number];
export const policies: Record<Task, string> = {
  "click-test": "await page.locator('#subbtn').click();",
  "enter-text": `const text = await page.evaluate(() => document.querySelector('#query .bold').textContent);
await page.locator('#tt').fill(text); await page.locator('#subbtn').click();`,
  "read-table": `const answer = await page.evaluate(() => {
  const key = document.querySelector('#query .bold').textContent;
  const row = [...document.querySelectorAll('#tab tr')].find(row => row.cells[0].textContent === key);
  if (!row) throw Error('Visible row not found'); return row.cells[1].textContent;
});
await page.locator('#tt').fill(answer); await page.locator('#subbtn').click();`,
};
export interface EpisodeResult {
  task: Task;
  seed: number;
  success: boolean;
  done: boolean;
  rawReward: number | null;
  envReward: number | null;
  solveMs: number | null;
  totalMs: number;
  solveMcpCalls: number;
  totalMcpCalls: number;
  browserSteps: number | null;
  cleanup: boolean;
  error?: string;
}
export function upstreamSuccess(value: { done: boolean; rawReward: number | null }): boolean {
  return value.done && value.rawReward === 1;
}
export function summarize(results: EpisodeResult[]) {
  return tasks.map((task) => {
    const episodes = results.filter((item) => item.task === task);
    const measured = episodes
      .flatMap((item) => (item.solveMs === null ? [] : [item.solveMs]))
      .sort((a, b) => a - b);
    const n = measured.length;
    return {
      task,
      episodes: episodes.length,
      succeeded: episodes.filter((item) => item.success).length,
      timedEpisodes: n,
      solveP50Ms: n ? (measured[Math.floor((n - 1) / 2)]! + measured[Math.floor(n / 2)]!) / 2 : null,
      solveP95Ms: n ? measured[Math.ceil(n * 0.95) - 1]! : null,
      totalMeanMs: episodes.length
        ? episodes.reduce((sum, item) => sum + item.totalMs, 0) / episodes.length
        : null,
      solveMcpCalls: episodes.reduce((sum, item) => sum + item.solveMcpCalls, 0),
      browserSteps: episodes.reduce((sum, item) => sum + (item.browserSteps ?? 0), 0),
      unknownStepEpisodes: episodes.filter((item) => item.browserSteps === null).length,
      cleaned: episodes.filter((item) => item.cleanup).length,
    };
  });
}
export async function serveMiniwob(cache: string, data: SourceManifest = source) {
  const files = new Map<string, Buffer>();
  await mkdir(cache, { recursive: true });
  for (const [path, expected] of Object.entries(data.files)) {
    const local = join(cache, path);
    let bytes = await readFile(local).catch(() => undefined);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
      const response = await fetch(
        `https://raw.githubusercontent.com/Farama-Foundation/miniwob-plusplus/${data.commit}/${path}`,
        {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        },
      );
      if (!response.ok) throw Error(`Upstream file unavailable (${response.status}): ${path}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== expected)
        throw Error(`Upstream checksum mismatch: ${path}`);
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, bytes);
    }
    files.set("/" + path.replace("miniwob/html/", ""), bytes);
  }
  // Retain the upstream license alongside downloaded source, outside the repository.
  const licensePath = join(cache, "LICENSE");
  if (!(await readFile(licensePath).catch(() => undefined))) {
    const response = await fetch(
      `https://raw.githubusercontent.com/Farama-Foundation/miniwob-plusplus/${data.commit}/LICENSE`,
      { signal: AbortSignal.timeout(30_000), redirect: "error" },
    );
    if (!response.ok) throw Error(`Upstream license unavailable (${response.status})`);
    await writeFile(licensePath, await response.text());
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const bytes = files.get(path);
    if (req.method !== "GET" || !bytes) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".png")
            ? "image/png"
            : path.endsWith(".gif")
              ? "image/gif"
              : path.endsWith(".css")
                ? "text/css"
                : "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      })
      .end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

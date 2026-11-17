import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentGateway } from "../bench/gateway.js";

async function fixture(maxToolCalls = 40) {
  const forwarded: {
    body: Record<string, unknown>;
    authorization: string | undefined;
    host: string | undefined;
    accept: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      forwarded.push({
        body,
        authorization: request.headers.authorization,
        host: request.headers.host,
        accept: request.headers.accept,
      });
      const accepted = request.headers.accept ?? "";
      if (!accepted.includes("application/json") || !accepted.includes("text/event-stream")) {
        response.writeHead(406).end("Both JSON and SSE must be accepted");
        return;
      }
      if (body.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const tools = [
        "browser_observe",
        "browser_read",
        "browser_act",
        "browser_wait",
        "browser_exec",
        "session_open",
      ].map((name) => ({
        name,
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            selector: { type: "string" },
            frame_selector: { type: "string" },
          },
          required: ["session_id"],
        },
      }));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "tools/list"
              ? { tools }
              : { content: [{ type: "image", mimeType: "image/png", data: "fictional-base64" }] },
        }),
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const targetUrl = `http://127.0.0.1:${address.port}`;
  let exceeded = 0;
  const gateway = await createAgentGateway({
    targetUrl,
    targetToken: "private-upstream-token",
    sessionId: "episode-session",
    maxToolCalls,
    onBudgetExceeded: () => {
      exceeded++;
    },
  });
  async function post(method: string, params?: Record<string, unknown>, id: string | number = "rpc-id") {
    return fetch(gateway.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.token}`,
        "content-type": "application/json",
        host: "untrusted-agent-host",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    });
  }
  return {
    gateway,
    forwarded,
    post,
    targetUrl,
    exceeded: () => exceeded,
    async close() {
      await gateway.close();
      await gateway.close();
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("gateway allows only native tools in its episode, preserves RPC IDs and replaces credentials", async () => {
  const f = await fixture();
  try {
    assert.notEqual(f.gateway.token, "private-upstream-token");
    const valid = await f.post(
      "tools/call",
      { name: "browser_observe", arguments: { session_id: "episode-session", screenshot: true } },
      73,
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), {
      jsonrpc: "2.0",
      id: 73,
      result: { content: [{ type: "image", mimeType: "image/png", data: "fictional-base64" }] },
    });
    assert.equal(f.forwarded[0]?.authorization, "Bearer private-upstream-token");
    assert.ok(f.forwarded[0]?.accept?.includes("application/json"));
    assert.ok(f.forwarded[0]?.accept?.includes("text/event-stream"));
    assert.notEqual(f.forwarded[0]?.host, "untrusted-agent-host");
    for (const params of [
      { name: "browser_exec", arguments: { session_id: "episode-session" } },
      { name: "browser_act", arguments: { session_id: "other-session" } },
      { name: "browser_read", arguments: { session_id: "episode-session", selector: "script" } },
      { name: "browser_read", arguments: { session_id: "episode-session", frame_selector: "iframe" } },
    ]) {
      const result = await f.post("tools/call", params, "rejected-id");
      assert.equal(result.status, 403);
      assert.equal(((await result.json()) as { id: string }).id, "rejected-id");
    }
    assert.equal(f.forwarded.length, 1);
    assert.equal(f.gateway.violations.length, 4);
    assert.equal(f.gateway.calls.length, 5);
    assert.ok(f.gateway.calls.every((call) => call.elapsedMs >= 0 && call.status > 0));
    const diagnostics = JSON.stringify({ calls: f.gateway.calls, violations: f.gateway.violations });
    assert.ok(!diagnostics.includes("private-upstream-token") && !diagnostics.includes(f.targetUrl));
  } finally {
    await f.close();
  }
});

test("gateway filters tools/list and restricts read schema, while initialization consumes no budget", async () => {
  const f = await fixture(1);
  try {
    for (const method of ["initialize", "ping", "resources/list", "prompts/list"])
      assert.equal((await f.post(method)).status, 200);
    const notification = await f.post("notifications/initialized");
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), "");
    const response = await f.post("tools/list");
    const listing = (await response.json()) as {
      result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] };
    };
    assert.deepEqual(
      listing.result.tools.map((tool) => tool.name),
      ["browser_observe", "browser_read", "browser_act", "browser_wait"],
    );
    const read = listing.result.tools.find((tool) => tool.name === "browser_read");
    assert.deepEqual(read?.inputSchema.properties.selector, { type: "string", enum: ["body"] });
    assert.ok(!Object.hasOwn(read!.inputSchema.properties, "frame_selector"));
    assert.equal(f.gateway.calls.length, 0);
    for (const selector of [undefined, "body"]) {
      const result = await f.post("tools/call", {
        name: "browser_read",
        arguments: { session_id: "episode-session", ...(selector ? { selector } : {}) },
      });
      assert.equal(result.status, selector ? 429 : 200);
    }
    assert.equal(f.gateway.budgetExceeded, true);
  } finally {
    await f.close();
  }
});

test("gateway forwards exactly forty tool calls and rejects all later calls before upstream", async () => {
  const f = await fixture(40);
  try {
    for (let i = 0; i < 42; i++) {
      const response = await f.post(
        "tools/call",
        { name: "browser_wait", arguments: { session_id: "episode-session", timeout_ms: 1 } },
        i,
      );
      assert.equal(response.status, i < 40 ? 200 : 429);
      assert.equal(((await response.json()) as { id: number }).id, i);
    }
    assert.equal(f.forwarded.length, 40);
    assert.equal(f.gateway.budgetExceeded, true);
    assert.equal(f.exceeded(), 1);
    assert.deepEqual(
      f.gateway.calls.slice(40).map((call) => call.status),
      [429, 429],
    );
  } finally {
    await f.close();
  }
});

test("gateway rejects unknown methods, invalid credentials and oversized JSON without forwarding", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post("resources/read", { uri: "private" })).status, 403);
    assert.equal((await fetch(f.gateway.url, { method: "POST", body: "{}" })).status, 401);
    const response = await fetch(f.gateway.url, {
      method: "POST",
      headers: { authorization: `Bearer ${f.gateway.token}` },
      body: JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal(f.forwarded.length, 0);
  } finally {
    await f.close();
  }
});

test("gateway close aborts an in-flight upstream request and is idempotent", async () => {
  let received!: () => void;
  const arrival = new Promise<void>((resolve) => {
    received = resolve;
  });
  const upstream = createServer((request) => {
    request.resume();
    request.on("end", received);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const gateway = await createAgentGateway({
    targetUrl: `http://127.0.0.1:${address.port}`,
    targetToken: "private-test-token",
    sessionId: "bound",
    maxToolCalls: 1,
  });
  try {
    const pending = fetch(gateway.url, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "in-flight",
        method: "tools/call",
        params: { name: "browser_observe", arguments: { session_id: "bound" } },
      }),
    }).then(
      () => "response",
      () => "disconnected",
    );
    await arrival;
    await Promise.all([gateway.close(), gateway.close()]);
    assert.equal(await pending, "disconnected");
  } finally {
    await gateway.close();
    await new Promise<void>((resolve, reject) => {
      upstream.closeAllConnections();
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

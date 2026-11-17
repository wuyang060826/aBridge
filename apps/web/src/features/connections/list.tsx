import { ChevronRight, Plus, Search } from "lucide-preact";
import { useState } from "preact/hooks";
import { type AgentConnectionView } from "@abridge/protocol";
import type { Device } from "../../lib/types.js";
import { Select } from "../../components/forms.js";
import { connectionCapabilities } from "./policy.js";

export function ConnectionsPage({
  connections,
  devices,
  create,
}: {
  connections: AgentConnectionView[];
  devices: Device[];
  create: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const owned = devices.filter((device) => device.status !== "revoked");
  const filtered = connections.filter(
    (connection) =>
      (filter === "all" ||
        (filter === "revoked" ? connection.revoked_at !== null : connection.revoked_at === null)) &&
      connection.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <div class="page-title">
        <div>
          <h1>Agent 连接</h1>
        </div>
        <button class="primary" onClick={create}>
          <Plus aria-hidden="true" />
          连接 Agent
        </button>
      </div>
      {connections.length > 0 && (
        <div class="device-toolbar">
          <label class="device-search">
            <span class="sr-only">搜索连接</span>
            <Search aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索连接名称…"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <Select
            aria-label="连接状态"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          >
            <option value="active">未撤销连接</option>
            <option value="all">全部连接</option>
            <option value="revoked">已撤销连接</option>
          </Select>
        </div>
      )}
      <section class="surface" aria-label="Agent 连接列表">
        {filtered.length ? (
          <>
            <div class="list-heading connection-list-heading">
              <span>连接名称</span>
              <span>设备范围</span>
              <span>有效期</span>
              <span />
            </div>
            {filtered.map((connection) => {
              const permitted = owned.filter(
                (device) => connectionCapabilities(connection, device).length > 0,
              );
              const expired = connection.expires_at !== null && connection.expires_at <= Date.now() / 1000;
              return (
                <a
                  class="connection-link-row"
                  href={`#connections/${encodeURIComponent(connection.id)}`}
                  key={connection.id}
                  data-connection-id={connection.id}
                >
                  <div>
                    <span class="name">{connection.name}</span>
                    <div class="device-meta">
                      <span
                        class={`dot ${connection.revoked_at !== null || expired ? "offline" : "online"}`}
                      />
                      {connection.revoked_at !== null ? "已撤销" : expired ? "已到期" : "有效"}
                      <span>/</span>
                      {connection.authentication === "platform" ? "平台授权" : "Agent Key"}
                    </div>
                  </div>
                  <div>
                    <span>
                      {connection.policy.mode === "all"
                        ? "全部设备（含新设备）"
                        : `${permitted.length} 台指定设备`}
                    </span>
                    <p class="small muted truncate">
                      {permitted.map((device) => device.name).join("、") || "暂无已授权设备"}
                    </p>
                  </div>
                  <span class="small muted">
                    {connection.expires_at
                      ? new Date(connection.expires_at * 1000).toLocaleDateString("zh-CN")
                      : "直到撤销"}
                  </span>
                  <ChevronRight aria-hidden="true" />
                </a>
              );
            })}
          </>
        ) : (
          <div class="empty">
            <div>
              <h2>{connections.length ? "没有符合条件的连接" : "暂无 Agent 连接"}</h2>
            </div>
            {connections.length ? (
              <button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                清除筛选
              </button>
            ) : (
              <button class="primary" onClick={create}>
                连接 Agent
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}

import { z } from "zod";
import { devicesListSchema, agentConnectionsListSchema } from "@abridge/protocol";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  data?: unknown,
  method = data === undefined ? "GET" : "POST",
  token?: string,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({ error: z.object({ message: z.string(), code: z.string().optional() }) })
      .safeParse(result);
    throw new ApiError(
      parsed.success ? parsed.data.error.message : `请求失败 (${response.status})`,
      response.status,
      parsed.success ? parsed.data.error.code : undefined,
    );
  }
  return schema.parse(result);
}
export const objectResultSchema = z.record(z.string(), z.unknown());
export async function loadData() {
  const [devices, connections] = await Promise.all([
    api("/api/devices", devicesListSchema),
    api("/api/agent-connections", agentConnectionsListSchema),
  ]);
  return { devices: devices.devices, connections: connections.connections };
}

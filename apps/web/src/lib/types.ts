import type { AgentConnectionView, DeviceView } from "@abridge/protocol";

/** A failed refresh invalidates realtime fields without discarding known device metadata. */
export type Device = Omit<DeviceView, "status" | "paused" | "available"> & {
  status: DeviceView["status"] | "unknown";
  paused?: boolean;
  available?: DeviceView["available"];
};
export type ManagementData = { devices: Device[]; connections: AgentConnectionView[] };
export type RunAction = (action: () => Promise<void>) => void;
export type Mutate = (path: string, body?: unknown, method?: string) => Promise<void>;

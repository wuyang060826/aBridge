import type { Capability, AgentConnectionView } from "@abridge/protocol";
import type { Device } from "../../lib/types.js";

export function connectionCapabilities(connection: AgentConnectionView, device: Device): Capability[] {
  const policy = connection.policy;
  const configured =
    policy.mode === "selected"
      ? (policy.devices.find((entry) => entry.device_id === device.id)?.capabilities ?? [])
      : (policy.overrides.find((entry) => entry.device_id === device.id)?.capabilities ??
        policy.capabilities);
  return device.capabilities.filter((cap) => configured.includes(cap));
}

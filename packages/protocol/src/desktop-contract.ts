/** Build-time native contract; all schemas and protocol constants originate in this package. */
import { z } from "zod";
import * as p from "./index.js";
export function desktopContract() {
  const schemas = {
    operation: p.operationFrameSchema,
    welcome: p.deviceWelcomeSchema,
    deviceBindingInput: p.deviceBindingInputSchema,
    windowsShellRequest: p.windowsShellRequestSchema,
    deviceAuthorizationRequest: p.deviceAuthorizationRequestSchema,
    deviceAuthorizationTokenRequest: p.deviceAuthorizationTokenRequestSchema,
    deviceAuthorizationStart: p.deviceAuthorizationStartSchema,
    deviceAuthorizationToken: p.deviceAuthorizationTokenSchema,
    deviceIdentity: p.deviceIdentitySchema,
    deviceRename: p.deviceRenameSchema,
    deviceRenameResult: p.deviceRenameResultSchema,
    ...Object.fromEntries(
      Object.entries(p.toolArgumentSchemas).filter(([name]) => !name.startsWith("browser_")),
    ),
  };
  return {
    version: p.VERSION,
    protocol: p.PROTOCOL_VERSION,
    capabilities: p.CAPABILITIES,
    desktopCapabilities: p.DESKTOP_CAPABILITIES,
    toolCapabilities: p.TOOL_CAPABILITIES,
    limits: {
      messageBytes: p.MAX_MESSAGE_BYTES,
      imageBytes: p.MAX_IMAGE_BYTES,
      desktopObservationSeconds: p.DESKTOP_OBSERVATION_SECONDS,
      operations: p.MAX_DEVICE_OPERATIONS,
      leaseSeconds: p.DEVICE_LEASE_SECONDS,
      heartbeatSeconds: p.HEARTBEAT_SECONDS,
      operationStartSeconds: p.OPERATION_START_SECONDS,
      operationGraceSeconds: p.OPERATION_START_GRACE_SECONDS,
      journalEntries: p.OPERATION_JOURNAL_LIMIT,
    },
    schemas: Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: "input" })]),
    ),
  };
}

import type { z } from "zod";
export class DesktopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: "refused" | "failed" | "outcome_unknown" = "refused",
  ) {
    super(message);
    this.name = "DesktopError";
  }
}
export function invalid(message: string): never {
  throw new DesktopError("invalid_arguments", message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Parse untrusted tool inputs into the shared contract before any local side effect. */
export function parseArguments<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid tool arguments");
  return parsed.data;
}

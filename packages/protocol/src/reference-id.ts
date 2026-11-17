import { z } from "zod";

// Public references stay short: a readable prefix and exactly 8 Base64URL characters.
export const observationIdSchema = z.string().regex(/^obs_[A-Za-z0-9_-]{8}$/);
export const snapshotIdSchema = z.string().regex(/^snap_[A-Za-z0-9_-]{8}$/);
export const operationIdPattern = /^op_[A-Za-z0-9_-]{8}$/;
type ReferenceKind = "obs" | "snap";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const limit = 2 ** 48;

export function createReferenceIdGenerator(start?: number): (kind: ReferenceKind) => string {
  if (start === undefined) {
    const words = crypto.getRandomValues(new Uint32Array(2));
    start = (words[0]! & 0xffff) * 2 ** 32 + words[1]!;
  }
  if (!Number.isSafeInteger(start) || start < 0 || start >= limit) throw Error("Invalid reference seed");
  let next = start;
  return (kind) => {
    // Share across sessions; never reset on invalidation or wrap into an old reference.
    if (next >= limit) throw Error("Reference IDs exhausted; restart the client");
    let value = next++;
    let suffix = "";
    for (let i = 0; i < 8; i++) {
      suffix = alphabet[value % 64] + suffix;
      value = Math.floor(value / 64);
    }
    return `${kind}_${suffix}`;
  };
}

let generate: ReturnType<typeof createReferenceIdGenerator> | undefined;
export function referenceId(kind: ReferenceKind): string {
  generate ??= createReferenceIdGenerator();
  return generate(kind);
}

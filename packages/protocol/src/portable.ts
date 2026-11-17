import { z } from "zod";

/** Declarative refinements travel with JSON Schema to non-JavaScript device clients. */
export type PortableRule = readonly [string, ...unknown[]];
export function evaluateRule(rule: PortableRule, value: unknown): boolean {
  const [op, ...args] = rule;
  const field = (key: unknown): unknown =>
    key === "" ? value : (value as Record<string, unknown>)?.[String(key)];
  const sub = (v: unknown) => evaluateRule(v as PortableRule, value);
  switch (op) {
    case "unique":
      return Array.isArray(value) && new Set(value).size === value.length;
    case "and":
      return args.every(sub);
    case "or":
      return args.some(sub);
    case "not":
      return !sub(args[0]);
    case "exists":
      return field(args[0]) !== undefined;
    case "truthy":
      return Boolean(field(args[0]));
    case "noNul":
      return typeof value === "string" && !value.includes("\0");
    case "nonblank":
      return typeof value === "string" && value.trim().length > 0;
    case "unicode":
      return typeof value === "string" && value.isWellFormed();
    case "utf8Max":
      return typeof value === "string" && new TextEncoder().encode(value).length <= Number(args[0]);
    default:
      throw new Error(`Unknown portable constraint: ${op}`);
  }
}
export function portable<T extends z.ZodType>(schema: T, rule: PortableRule, message: string): T {
  const prior = schema.meta()?.["x-rule"] as PortableRule | undefined;
  return schema
    .refine((value) => evaluateRule(rule, value), message)
    .meta({ "x-rule": prior ? ["and", prior, rule] : rule });
}

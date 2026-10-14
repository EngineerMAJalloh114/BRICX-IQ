// Issue paths for the error envelope (ruling 6). A segment is kept only if
// the schema declares it: a property name of an object schema, or an index
// into an array or tuple schema. Any other segment, a record key above all
// (it is user-controlled and may hold a secret), becomes "*". Paths are cut
// to LIMITS.pathDepth segments. Internal: not in the exports map.
import type { z } from "zod";
import { LIMITS } from "./limits.ts";

export type PathSegment = string | number;
export const WILDCARD = "*";

type Schema = z.core.$ZodType;

/** Wrapper and branch levels unwrapped per segment, against lazy cycles. */
const EXPAND_BUDGET = 256;

/**
 * The schemas `schema` may stand for at this level: wrappers (optional,
 * nullable, default, readonly, catch, lazy...) unwrapped, both sides of
 * pipes and intersections, every union option.
 */
function expand(schema: Schema, out: Schema[], seen: Set<Schema>): void {
  const stack: Schema[] = [schema];
  let budget = EXPAND_BUDGET;
  while (stack.length > 0 && budget > 0) {
    budget -= 1;
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const s = current as z.core.$ZodTypes;
    const def = s._zod.def;
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "readonly":
      case "catch":
      case "nonoptional":
        stack.push(def.innerType);
        break;
      case "lazy":
        stack.push(def.getter());
        break;
      case "pipe":
        stack.push(def.in, def.out);
        break;
      case "intersection":
        stack.push(def.left, def.right);
        break;
      case "union":
        stack.push(...def.options);
        break;
      default:
        out.push(current);
    }
  }
}

interface Step {
  /** Some schema at this level declares the segment. */
  readonly declared: boolean;
  /** The schemas the segment leads to (record values included). */
  readonly next: readonly Schema[];
}

function step(schemas: readonly Schema[], segment: PropertyKey): Step {
  const next: Schema[] = [];
  let declared = false;
  for (const schema of schemas) {
    const def = (schema as z.core.$ZodTypes)._zod.def;
    if (def.type === "object") {
      if (typeof segment === "string" && Object.hasOwn(def.shape, segment)) {
        const child = def.shape[segment];
        if (child !== undefined) next.push(child);
        declared = true;
      }
    } else if (def.type === "array") {
      if (typeof segment === "number") {
        next.push(def.element);
        declared = true;
      }
    } else if (def.type === "tuple") {
      const item =
        typeof segment === "number" ? (def.items[segment] ?? def.rest) : null;
      if (item !== null) {
        next.push(item);
        declared = true;
      }
    } else if (def.type === "record") {
      // A record key is never declared: it becomes "*", and the walk goes
      // on into the value schema.
      next.push(def.valueType);
    }
  }
  return { declared, next };
}

/** `path` with every undeclared segment replaced by "*", at most 32 long. */
export function sanitizePath(
  root: Schema,
  path: readonly PropertyKey[],
): PathSegment[] {
  const out: PathSegment[] = [];
  let schemas: Schema[] = [];
  expand(root, schemas, new Set());
  for (const segment of path.slice(0, LIMITS.pathDepth)) {
    const valid =
      (typeof segment === "number" &&
        Number.isSafeInteger(segment) &&
        segment >= 0) ||
      (typeof segment === "string" && segment.length <= LIMITS.pathSegment);
    const { declared, next } = step(schemas, segment);
    out.push(
      valid && declared && typeof segment !== "symbol" ? segment : WILDCARD,
    );
    const expanded: Schema[] = [];
    const seen = new Set<Schema>();
    for (const child of next) expand(child, expanded, seen);
    schemas = expanded;
  }
  return out;
}

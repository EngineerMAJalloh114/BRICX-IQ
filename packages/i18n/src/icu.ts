// ICU MessageFormat signatures (ADR 0046): argument names with their kinds,
// and the arm names of every select and plural. Bounded before parsing
// (P3 rule 9): length, then a linear brace pre-scan, then the parse, then
// the placeholder count. The parser is intl-messageformat's (the engine
// i18next-icu uses at run time), so the checker and the runtime read a
// message the same way.
import IntlMessageFormat from "intl-messageformat";
import { LIMITS, prescanMessage } from "./limits.ts";

/** An argument's kind as the message uses it. */
export type ArgKind =
  | "string"
  | "number"
  | "date"
  | "time"
  | "select"
  | "plural"
  | "selectordinal"
  | "tag";

export interface MessageSignature {
  /** Every argument name (nested ones included) and its kind. */
  readonly args: Readonly<Record<string, ArgKind>>;
  /** Arm names (sorted) of every select, plural and selectordinal argument. */
  readonly arms: Readonly<Record<string, readonly string[]>>;
}

export type SignatureFailure =
  | "message_too_long"
  | "too_many_placeholders"
  | "nesting_too_deep"
  | "invalid_icu"
  | "argument_conflict";

export type SignatureResult =
  | { readonly ok: true; readonly signature: MessageSignature }
  | { readonly ok: false; readonly reason: SignatureFailure };

// Element types of @formatjs/icu-messageformat-parser's AST.
const ARGUMENT = 1;
const NUMBER = 2;
const DATE = 3;
const TIME = 4;
const SELECT = 5;
const PLURAL = 6;
const TAG = 8;

// Maps, not objects: an argument named __proto__ or constructor is data.
interface Collector {
  readonly args: Map<string, ArgKind>;
  readonly arms: Map<string, Set<string>>;
  placeholders: number;
  conflict: boolean;
}

function record(acc: Collector, name: unknown, kind: ArgKind): void {
  if (typeof name !== "string") return;
  acc.placeholders += 1;
  const seen = acc.args.get(name);
  if (seen !== undefined && seen !== kind) acc.conflict = true;
  acc.args.set(name, kind);
}

function walkOptions(acc: Collector, name: unknown, options: unknown): void {
  if (
    typeof name !== "string" ||
    typeof options !== "object" ||
    options === null
  )
    return;
  const arms = acc.arms.get(name) ?? new Set<string>();
  acc.arms.set(name, arms);
  for (const [arm, option] of Object.entries(options)) {
    arms.add(arm);
    if (typeof option === "object" && option !== null) {
      walk(acc, Reflect.get(option, "value"));
    }
  }
}

function walk(acc: Collector, nodes: unknown): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes as unknown[]) {
    if (typeof node !== "object" || node === null) continue;
    const type: unknown = Reflect.get(node, "type");
    const name: unknown = Reflect.get(node, "value");
    switch (type) {
      case ARGUMENT:
        record(acc, name, "string");
        break;
      case NUMBER:
        record(acc, name, "number");
        break;
      case DATE:
        record(acc, name, "date");
        break;
      case TIME:
        record(acc, name, "time");
        break;
      case SELECT:
        record(acc, name, "select");
        walkOptions(acc, name, Reflect.get(node, "options"));
        break;
      case PLURAL:
        record(
          acc,
          name,
          Reflect.get(node, "pluralType") === "ordinal"
            ? "selectordinal"
            : "plural",
        );
        walkOptions(acc, name, Reflect.get(node, "options"));
        break;
      case TAG:
        record(acc, name, "tag");
        walk(acc, Reflect.get(node, "children"));
        break;
      default:
        // Literal text and `#`.
        break;
    }
  }
}

/** The signature of `message`, or the first bound or parse failure. */
export function messageSignature(
  message: string,
  locale: string,
): SignatureResult {
  if (message.length > LIMITS.message)
    return { ok: false, reason: "message_too_long" };
  const scan = prescanMessage(message);
  if (scan.braces > LIMITS.braces)
    return { ok: false, reason: "too_many_placeholders" };
  if (scan.depth > 2 * LIMITS.depth)
    return { ok: false, reason: "nesting_too_deep" };
  let ast: unknown;
  try {
    ast = new IntlMessageFormat(message, locale, undefined, {
      ignoreTag: false,
    }).getAst();
  } catch {
    return { ok: false, reason: "invalid_icu" };
  }
  const acc: Collector = {
    args: new Map(),
    arms: new Map(),
    placeholders: 0,
    conflict: false,
  };
  walk(acc, ast);
  if (acc.placeholders > LIMITS.placeholders)
    return { ok: false, reason: "too_many_placeholders" };
  if (acc.conflict) return { ok: false, reason: "argument_conflict" };
  // Object.fromEntries defines own properties, so a __proto__ key stays data.
  const args = Object.fromEntries(acc.args) as Record<string, ArgKind>;
  const arms = Object.fromEntries(
    [...acc.arms].map(([name, set]) => [name, [...set].sort()]),
  );
  return { ok: true, signature: { args, arms } };
}

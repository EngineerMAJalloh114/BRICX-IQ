// Input bounds (P3 rule 9, ADR 0046 D8). Every input is checked against
// these before any parsing or other work that grows with its size.

export const LIMITS = Object.freeze({
  /** Characters in a language tag (RFC 5646 section 4.4.1's buffer). */
  localeTag: 35,
  /** Entries in a fallback chain (project, user, device, and spares). */
  chain: 8,
  /** Characters in a message key, namespace included. */
  key: 128,
  /** UTF-16 code units in one message. */
  message: 1000,
  /** `{` characters in one message, checked before parsing. */
  braces: 64,
  /**
   * Nested arguments in one message (a select inside a plural is 2). Each
   * level opens two braces (the argument and its arm), so the pre-scan
   * rejects a brace depth above 2 x depth before parsing.
   */
  depth: 4,
  /** Placeholders (argument references) in one message, after the bounded parse. */
  placeholders: 20,
  /** Arguments passed to one t() call. */
  args: 20,
  /** UTF-16 code units in one string argument. */
  argString: 1000,
  /** Bytes in one catalog or glossary file, checked before JSON.parse. */
  catalogBytes: 262_144,
});

export interface Prescan {
  /** Number of `{` characters. */
  readonly braces: number;
  /** Deepest brace nesting reached. */
  readonly depth: number;
}

/**
 * One linear pass over `text` counting braces and their nesting. ICU quoting
 * is ignored on purpose: a quoted brace only makes the count higher, so the
 * bound can only get stricter.
 */
export function prescanMessage(text: string): Prescan {
  let braces = 0;
  let depth = 0;
  let open = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x7b) {
      braces += 1;
      open += 1;
      if (open > depth) depth = open;
    } else if (ch === 0x7d && open > 0) {
      open -= 1;
    }
  }
  return { braces, depth };
}

/**
 * A message key's shape after its namespace (`errors:money.out_of_range`
 * checks `money.out_of_range`): dot-separated lowercase segments. Exported
 * for @bricx/validation's drift test (P3-04, ADR 0047).
 */
export const KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;

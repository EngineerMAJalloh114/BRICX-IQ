// A secret config value (P2-03, ADR 0039). Every rendering a log line,
// a JSON body or a debugger could produce is "[redacted]"; the value comes
// out only through reveal(). Held in a private field, so neither
// structuredClone nor inspect(..., { customInspect: false }) sees it.

const REDACTED = "[redacted]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  /** The secret value. Call it only where the value is used, never to log. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  // Node's util.inspect (console.log, %o, %O) and the REPL.
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

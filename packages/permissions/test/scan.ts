// The import scanner client-safe.test.ts and the sabotage checks share.

/** [specifier, type-only] for every import/export-from, dynamic import and require. */
export function imports(code: string): [string, boolean][] {
  const found: [string, boolean][] = [];
  // Anchored at a line start, so the word "import" in a comment is not read
  // as the start of a statement.
  for (const m of code.matchAll(
    /^\s*(?:import|export)\s+(type\s+)?[^"';]*?\bfrom\s*["']([^"']+)["']/gm,
  )) {
    found.push([m[2] ?? "", m[1] !== undefined]);
  }
  for (const m of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    found.push([m[1] ?? "", false]);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    found.push([m[1] ?? "", false]);
  }
  for (const m of code.matchAll(/\brequire\s*\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    found.push([m[1] ?? "", false]);
  }
  return found;
}

/** Value imports src/ may make. */
export const VALUE_ALLOWED =
  /^(?:\.\/[a-z0-9-]+\.ts|@casl\/ability|@bricx\/ids\/(?:branded|uuid-v7))$/;
/** Imports src/ may make as types only (ruling 8). */
export const TYPE_ONLY_ALLOWED = /^@bricx\/i18n\/keys$/;

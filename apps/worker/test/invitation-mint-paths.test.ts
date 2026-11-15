// P6-06c (ADR 0085; owner condition C5: "no second mint"; sabotage S16):
// a registry over the source tree.
// - The only statement that stores a token (token_hash set to a value, not
//   NULL) is mintInvitationToken in packages/db/src/invitations.ts.
// - mintInvitationToken is called only by the send step
//   (apps/worker/src/invitations/send.ts): the bulk consumer mints nothing.
// - A pending invitation row is written only by insertPendingInvitation in
//   packages/db/src/invitations.ts, which the single invite (the API's
//   invitations module) and the bulk consumer both call: no other file
//   inserts into bricx.invitations.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const ROOTS = ["apps", "packages", "tooling"];
const SKIP = new Set(["node_modules", "dist", "test", "migrations", ".turbo"]);

async function sources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sources(full, out);
    else if (
      /\.(ts|mts|js|mjs)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

async function filesMatching(
  test: (text: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of await sources(path.join(repoRoot, root))) {
      if (test(await readFile(file, "utf8"))) {
        found.push(path.relative(repoRoot, file).split(path.sep).join("/"));
      }
    }
  }
  return found.sort();
}

/** A token_hash assignment to anything but NULL (a WHERE comparison is not one). */
const STORES_TOKEN = /\bSET\b[^;]*?\btoken_hash\s*=(?!\s*NULL\b)/is;
const STORES_TOKEN_LINE = /^\s*(?:SET\s+|,\s*)?token_hash\s*=(?!\s*NULL\b)/im;

describe("invitation mint and insert paths (C5, S16)", () => {
  test("one statement stores a token: mintInvitationToken in @bricx/db/invitations", async () => {
    expect(
      await filesMatching(
        (text) => STORES_TOKEN.test(text) && STORES_TOKEN_LINE.test(text),
      ),
    ).toEqual(["packages/db/src/invitations.ts"]);
  });

  test("mintInvitationToken is called only by the send step", async () => {
    expect(
      await filesMatching((text) => /\bmintInvitationToken\s*\(/.test(text)),
    ).toEqual([
      "apps/worker/src/invitations/send.ts",
      "packages/db/src/invitations.ts",
    ]);
  });

  test("one INSERT into bricx.invitations, called by the single invite and the bulk consumer", async () => {
    expect(
      await filesMatching((text) =>
        /INSERT\s+INTO\s+bricx\.invitations\b/i.test(text),
      ),
    ).toEqual(["packages/db/src/invitations.ts"]);
    expect(
      await filesMatching((text) =>
        /\binsertPendingInvitation\s*\(/.test(text),
      ),
    ).toEqual([
      "apps/api/src/modules/invitations/invitations.repository.ts",
      "apps/worker/src/invitations/bulk.ts",
      "packages/db/src/invitations.ts",
    ]);
  });
});

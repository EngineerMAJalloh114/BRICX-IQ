// The seed dataset (P6-05b, ADR 0076; binding decisions F, G, J1, K1 and
// requirements 3 and 4; architect calls 1 and 4):
// - every seeded id is a fixed UUIDv7 literal committed in seed/ids.ts,
//   stamped with the seed instant, unique, and reproducible from its name
//   (deriveSeedId), so nobody hand-edits one;
// - two organisations in two region cells (af-south-1, eu-west-1), each
//   with one user per default role bundle (ROLE_IDS), the bundles copied
//   from @bricx/permissions, one project and two sites;
// - the six currencies and en/fr/ar (one RTL language) appear;
// - fake values only; no clock, no randomness, no pool in seed/*.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isRTL } from "@bricx/i18n/rtl";
import { isUuidV7, parseUuidV7 } from "@bricx/ids/uuid-v7";
import { ROLE_IDS, ROLES } from "@bricx/permissions/roles";
import { describe, expect, it } from "vitest";
import {
  SEED_INSTANT,
  SEED_INSTANT_MS,
  type SeedDataset,
  buildDataset,
} from "../seed/dataset.js";
import { deriveSeedId } from "../seed/derive.js";
import { SEED_IDS, seedId } from "../seed/ids.js";

const seedDir = path.join(import.meta.dirname, "../seed");
const dataset: SeedDataset = buildDataset(seedId);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every string in `value` that looks like a UUID, with its path. */
function uuidsIn(value: unknown, at = "$"): [string, string][] {
  if (typeof value === "string") return UUID.test(value) ? [[at, value]] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => uuidsIn(item, `${at}[${String(i)}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      uuidsIn(item, `${at}.${key}`),
    );
  }
  return [];
}

/** The ids of the rows the seed writes (fields named `id`). */
const rowIds = uuidsIn(dataset)
  .filter(([at]) => at.endsWith(".id"))
  .map(([, id]) => id);

/** Unix ms of a UUIDv7's first 48 bits. */
const msOf = (id: string): number =>
  Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

describe("seed ids (F)", () => {
  it("every id in the dataset is a committed UUIDv7 literal at the seed instant", () => {
    const committed = new Set(Object.values(SEED_IDS));
    for (const [at, id] of uuidsIn(dataset)) {
      expect(isUuidV7(id), at).toBe(true);
      expect(parseUuidV7(id).ok, at).toBe(true);
      expect(msOf(id), at).toBe(SEED_INSTANT_MS);
      expect(committed.has(id), at).toBe(true);
    }
  });

  it("row ids are unique, and so are the committed literals", () => {
    expect(new Set(rowIds).size).toBe(rowIds.length);
    const literals = Object.values(SEED_IDS);
    expect(new Set(literals).size).toBe(literals.length);
  });

  it("each literal is reproducible from its name, and every committed name is used", () => {
    const used: string[] = [];
    const derived = buildDataset((name) => {
      used.push(name);
      return deriveSeedId(name);
    });
    expect(derived).toEqual(dataset);
    expect([...new Set(used)].sort()).toEqual(Object.keys(SEED_IDS).sort());
    for (const [name, id] of Object.entries(SEED_IDS)) {
      expect(deriveSeedId(name), name).toBe(id);
    }
  });

  it("an unknown name is refused, naming nothing but the fact", () => {
    expect(() => seedId("org/z")).toThrow(/no committed seed id/);
  });
});

describe("seed instant (G)", () => {
  it("is 2026-01-01T00:00:00Z, and every timestamp in the dataset is it", () => {
    expect(SEED_INSTANT).toBe("2026-01-01T00:00:00.000Z");
    expect(Date.parse(SEED_INSTANT)).toBe(SEED_INSTANT_MS);
    expect(dataset.instant).toBe(SEED_INSTANT);
  });

  it("building twice gives equal datasets", () => {
    expect(buildDataset(seedId)).toEqual(dataset);
  });
});

describe("organisations (J1, K1)", () => {
  it("two organisations in two region cells", () => {
    expect(dataset.orgs.map((o) => o.dataRegion)).toEqual([
      "af-south-1",
      "eu-west-1",
    ]);
    expect(new Set(dataset.orgs.map((o) => o.slug)).size).toBe(2);
  });

  it("each organisation has the twelve roles with the default bundles", () => {
    for (const org of dataset.orgs) {
      expect(org.roles.map((r) => r.key)).toEqual([...ROLE_IDS]);
      for (const role of org.roles) {
        const expected = role.key === "owner" ? [] : [...ROLES[role.key]];
        expect(
          role.permissions.map((p) => p.permission),
          `${org.key}/${role.key}`,
        ).toEqual(expected);
      }
    }
  });

  it("each organisation has one user per role, a member with that role", () => {
    for (const org of dataset.orgs) {
      expect(org.users.map((u) => u.role)).toEqual([...ROLE_IDS]);
      for (const user of org.users) {
        expect(user.sub).toBe(`seed-${org.key}-${user.role}`);
      }
    }
    const subs = dataset.orgs.flatMap((o) => o.users.map((u) => u.sub));
    expect(new Set(subs).size).toBe(2 * ROLE_IDS.length);
  });
});

describe("projects and sites (architect call 1)", () => {
  it("each organisation has one project created by its owner, with two sites", () => {
    for (const org of dataset.orgs) {
      const owner = org.users.find((u) => u.role === "owner");
      expect(org.project.createdBy).toBe(owner?.id);
      expect(org.project.status).toBe("active");
      expect(org.sites).toHaveLength(2);
    }
  });

  it("each boundary is a closed ring of four corners, counter-clockwise", () => {
    for (const site of dataset.orgs.flatMap((o) => o.sites)) {
      expect(site.boundary.type).toBe("Polygon");
      expect(site.boundary.coordinates).toHaveLength(1);
      const ring = site.boundary.coordinates[0] ?? [];
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual(ring[4]);
      let twiceArea = 0;
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1 = 0, y1 = 0] = ring[i] ?? [];
        const [x2 = 0, y2 = 0] = ring[i + 1] ?? [];
        twiceArea += x1 * y2 - x2 * y1;
      }
      expect(twiceArea, site.name).toBeGreaterThan(0);
    }
  });

  it("project members are the project roles; site roles are assigned to site 1", () => {
    for (const org of dataset.orgs) {
      const roleOf = new Map(org.users.map((u) => [u.id, u.role]));
      expect(org.projectMembers.map((m) => roleOf.get(m.userId))).toEqual([
        "project_owner",
        "project_manager",
        "quantity_surveyor",
        "site_engineer",
        "foreman",
        "storekeeper",
        "client",
        "consultant",
        "subcontractor",
      ]);
      expect(org.siteAssignments.map((a) => roleOf.get(a.userId))).toEqual([
        "site_engineer",
        "foreman",
      ]);
      for (const assignment of org.siteAssignments) {
        expect(assignment.siteId).toBe(org.sites[0]?.id);
        const member = org.projectMembers.find(
          (m) => m.id === assignment.projectMembershipId,
        );
        expect(member?.userId).toBe(assignment.userId);
      }
    }
  });
});

describe("currencies and languages", () => {
  it("covers USD, EUR, SLE, NGN, KES and GHS", () => {
    const codes = new Set(
      dataset.orgs.flatMap((o) => [
        o.defaultCurrency,
        o.regionConfig.reportingCurrency,
        o.project.currency,
        o.project.reportingCurrency,
      ]),
    );
    expect([...codes].sort()).toEqual(
      ["EUR", "GHS", "KES", "NGN", "SLE", "USD"].sort(),
    );
  });

  it("covers en, fr and ar, and ar is the RTL case", () => {
    const languages = new Set(
      dataset.orgs.flatMap((o) => [
        o.defaultLanguage,
        o.project.regionConfig.language,
      ]),
    );
    expect([...languages].sort()).toEqual(["ar", "en", "fr"]);
    expect(isRTL("ar")).toBe(true);
    expect([...languages].filter((l) => isRTL(l))).toEqual(["ar"]);
  });
});

describe("no secrets (requirement 4)", () => {
  it("the dataset holds fake values only", () => {
    const text = JSON.stringify(dataset).toLowerCase();
    for (const word of [
      "password",
      "secret",
      "token",
      "bearer",
      "private",
      "@",
      "postgres://",
    ]) {
      expect(text).not.toContain(word);
    }
    for (const org of dataset.orgs) {
      expect(org.slug.startsWith("seed-")).toBe(true);
      expect(org.legalName).toContain("(seed)");
    }
  });
});

describe("seed sources (D, requirement 3)", () => {
  const files = readdirSync(seedDir).filter((f) => f.endsWith(".ts"));
  const sources = files.map((f) => ({
    file: f,
    text: readFileSync(path.join(seedDir, f), "utf8"),
  }));

  it("has the expected files", () => {
    expect(files.sort()).toEqual([
      "dataset.ts",
      "derive.ts",
      "generate-ids.ts",
      "ids.ts",
      "run.ts",
      "seed.ts",
    ]);
  });

  it("never reads the real clock or an unseeded random source", () => {
    for (const { file, text } of sources) {
      for (const banned of [
        "Date.now(",
        "new Date()",
        "Math.random",
        "performance.now",
        "randomUUID",
        "randomBytes",
        "getRandomValues",
        "process.hrtime",
      ]) {
        expect(text.includes(banned), `${file}: ${banned}`).toBe(false);
      }
    }
  });

  it("never opens a pool or a raw client: withTx() is the only way in", () => {
    for (const { file, text } of sources) {
      for (const banned of [
        'from "pg"',
        "new Pool",
        "new Client",
        "openRelayDatabase",
        "openDirectoryDatabase",
        "@bricx/db-bootstrap",
        "MIGRATION_DATABASE_URL",
        ".query(",
      ]) {
        expect(text.includes(banned), `${file}: ${banned}`).toBe(false);
      }
    }
    const seed = sources.find((s) => s.file === "seed.ts")?.text ?? "";
    expect(seed).toContain(".withTx(");
    const run = sources.find((s) => s.file === "run.ts")?.text ?? "";
    expect(run).toContain("loadSeedConfig(");
    expect(run).toContain("openDatabase(");
  });
});

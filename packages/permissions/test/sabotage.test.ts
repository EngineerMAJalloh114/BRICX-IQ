// Sabotage (P3 rule 1, permanent): every check in checks.ts passes on the
// real code and fails on its deliberately broken variant in mutants.ts. If a
// check stops catching its mutant, this file fails.
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkGenerated } from "../scripts/gen-lib.mjs";
import { buildAbility, can } from "../src/ability.ts";
import {
  DEFAULT_MODEL,
  generateRls,
  syncStreams,
  validateModel,
} from "../src/generate.ts";
import { LIMITS } from "../src/limits.ts";
import { checkSod } from "../src/sod.ts";
import { SOD_RULES } from "../src/sod-rules.ts";
import {
  checkAuthoringPaired,
  checkClientSafeSource,
  checkDenyByDefault,
  checkGrantsBound,
  checkNoInputInErrors,
  checkOrgPinned,
  checkRlsPrimitives,
  checkRoleScope,
  checkSodPairs,
  checkSodTable,
  checkStaleDetected,
  checkStreamsFiltered,
  checkTypeOnlyDenied,
} from "./checks.ts";
import type { Can } from "./checks.ts";
import {
  buildEchoesInput,
  buildManageAll,
  buildNoSentinels,
  buildReadsFirst,
  buildWithoutOrg,
  checkGeneratedPresenceOnly,
  rawTypeCan,
  rlsHasGrant,
  sodIgnoresChain,
  sodInverted,
  sodRulesWithoutBudgetUpdate,
  sodWithoutBudgetUpdate,
  sourceImportsI18nValue,
  sourceImportsMoney,
  sourceImportsNode,
  streamsUnfiltered,
  validateSkipsScope,
} from "./mutants.ts";
import { TYPE_ONLY_ALLOWED, VALUE_ALLOWED, imports } from "./scan.ts";

const realCan = can as unknown as Can;
const generatedDir = path.join(import.meta.dirname, "../generated");
const tmp = mkdtempSync(path.join(tmpdir(), "bricx-permissions-sabotage-"));
const staleDir = path.join(tmp, "stale");
cpSync(generatedDir, staleDir, { recursive: true });
writeFileSync(
  path.join(staleDir, "rls.sql"),
  readFileSync(path.join(generatedDir, "rls.sql"), "utf8").replace(
    "app.current_org()",
    "app.current_org( )",
  ),
);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
const realSource = readFileSync(
  path.join(import.meta.dirname, "../src/ability.ts"),
  "utf8",
);
const scanCheck = (code: string) => {
  checkClientSafeSource(imports, VALUE_ALLOWED, TYPE_ONLY_ALLOWED, code);
};

describe("the checks pass on the real code", () => {
  it("all of them", async () => {
    checkTypeOnlyDenied(buildAbility, realCan);
    checkOrgPinned(buildAbility, realCan);
    checkDenyByDefault(buildAbility, realCan);
    checkSodPairs(checkSod);
    checkSodTable(checkSod);
    checkAuthoringPaired(validateModel, DEFAULT_MODEL);
    checkGrantsBound(buildAbility, LIMITS.grants);
    checkRoleScope(validateModel, DEFAULT_MODEL);
    checkNoInputInErrors(buildAbility);
    await checkStaleDetected(checkGenerated, staleDir);
    checkStreamsFiltered(syncStreams, DEFAULT_MODEL);
    checkRlsPrimitives(generateRls, DEFAULT_MODEL);
    scanCheck(realSource);
  });
});

describe("each mutant is caught", () => {
  it.each([
    [
      "raw type-only check (ruling 1)",
      () => {
        checkTypeOnlyDenied(buildAbility, rawTypeCan);
      },
    ],
    [
      "rules without the orgId condition",
      () => {
        checkOrgPinned(buildWithoutOrg, realCan);
      },
    ],
    [
      "a manage/all rule",
      () => {
        checkDenyByDefault(buildManageAll, realCan);
      },
    ],
    [
      "no anyAction sentinel",
      () => {
        checkDenyByDefault(buildNoSentinels, realCan);
      },
    ],
    [
      "SoD ignores the chain",
      () => {
        checkSodPairs(sodIgnoresChain);
      },
    ],
    [
      "SoD actor comparison inverted",
      () => {
        checkSodPairs(sodInverted);
      },
    ],
    [
      "bounds checked after reading",
      () => {
        checkGrantsBound(buildReadsFirst, LIMITS.grants);
      },
    ],
    [
      "a role at a disallowed scope accepted",
      () => {
        checkRoleScope(validateSkipsScope, DEFAULT_MODEL);
      },
    ],
    [
      "input echoed in an error",
      () => {
        checkNoInputInErrors(buildEchoesInput);
      },
    ],
    [
      "streams without the permission filter",
      () => {
        checkStreamsFiltered(streamsUnfiltered, DEFAULT_MODEL);
      },
    ],
    [
      "RLS calling a per-permission helper",
      () => {
        checkRlsPrimitives(rlsHasGrant, DEFAULT_MODEL);
      },
    ],
    [
      "a node:fs import in src",
      () => {
        scanCheck(sourceImportsNode);
      },
    ],
    [
      "a money import in src",
      () => {
        scanCheck(sourceImportsMoney);
      },
    ],
    [
      "a value import of @bricx/i18n in src",
      () => {
        scanCheck(sourceImportsI18nValue);
      },
    ],
  ] as const)("%s", (_name, run) => {
    expect(run).toThrow();
  });

  it("one update pair dropped (finance.budget.update|approve): validateModel and the exhaustive table both fail", () => {
    expect(sodRulesWithoutBudgetUpdate).toHaveLength(SOD_RULES.length - 1);
    expect(
      validateModel({
        ...DEFAULT_MODEL,
        sodRules: sodRulesWithoutBudgetUpdate,
      }),
    ).toContain("authoring_action_not_paired:finance.budget.update");
    expect(() => {
      checkSodTable(sodWithoutBudgetUpdate);
    }).toThrow();
  });

  it("a stale generated file (presence-only check)", async () => {
    await expect(
      checkStaleDetected(checkGeneratedPresenceOnly, staleDir),
    ).rejects.toThrow();
  });
});

// Deliberately broken variants for the sabotage tests (P3 rule 1). Each is
// the real behaviour with one defect; sabotage.test.ts runs the checks in
// checks.ts against every one and requires them to fail.
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkGenerated } from "../scripts/gen-lib.mjs";
import { buildAbility, parseGrants } from "../src/ability.ts";
import type { Ability, Grant } from "../src/ability.ts";
import type { AbilityContext } from "../src/ability.ts";
import { generateRls, syncStreams, validateModel } from "../src/generate.ts";
import type { Model } from "../src/generate.ts";
import { abilityFromRules, engineOf, rulesFor } from "../src/rules.ts";
import type { CaslRule } from "../src/rules.ts";
import { checkSod } from "../src/sod.ts";
import { checkSodWith } from "../src/sod-check.ts";
import { SOD_RULES } from "../src/sod-rules.ts";
import type { SodAttempt } from "../src/sod.ts";
import { OTHER_USER } from "./helpers.ts";

/** Ruling 1's trap: the raw CASL check on a subject TYPE, record ignored. */
export const rawTypeCan = (
  ability: Ability,
  action: string,
  subject: string,
): boolean => engineOf(ability)?.can(action, subject) ?? false;

/** Rules without the orgId condition. */
export const buildWithoutOrg = (
  grants: readonly Grant[],
  context: AbilityContext,
): Ability =>
  abilityFromRules(
    rulesFor(parseGrants(grants), context).map((rule) => {
      const conditions: Record<string, unknown> = { ...rule.conditions };
      delete conditions.orgId;
      return {
        ...rule,
        conditions: conditions as unknown as CaslRule["conditions"],
      };
    }),
  );

/** The real rules plus CASL's manage/all, with CASL's own wildcard names. */
export const buildManageAll = (
  grants: readonly Grant[],
  context: AbilityContext,
): Ability =>
  abilityFromRules(
    [
      ...rulesFor(parseGrants(grants), context),
      {
        action: "manage",
        subject: "all",
        conditions: { orgId: context.orgId },
      },
    ],
    { wildcardSentinels: false },
  );

/** The real rules without the anyAction/anySubjectType sentinels (D5). */
export const buildNoSentinels = (
  grants: readonly Grant[],
  context: AbilityContext,
): Ability =>
  abilityFromRules(rulesFor(parseGrants(grants), context), {
    wildcardSentinels: false,
  });

/** checkSod that treats every history entry as the same chain. */
export const sodIgnoresChain = (attempt: SodAttempt) =>
  checkSod({
    ...attempt,
    history: attempt.history.map((h) => ({ ...h, chainId: attempt.chainId })),
  });

/** checkSod with the actor comparison inverted. */
export const sodInverted = (attempt: SodAttempt) =>
  checkSod({
    ...attempt,
    history: attempt.history.map((h) => ({
      ...h,
      actorId: h.actorId === attempt.actorId ? OTHER_USER : attempt.actorId,
    })),
  });

/** The SoD rules with one authoring-side update pair dropped (architect review 1). */
export const sodRulesWithoutBudgetUpdate = SOD_RULES.filter(
  (r) => r.id !== "finance.budget.update|finance.budget.approve",
);

/** checkSod over those rules. */
export const sodWithoutBudgetUpdate = (attempt: SodAttempt) =>
  checkSodWith(sodRulesWithoutBudgetUpdate, attempt);

/** buildAbility that reads every grant before the length check. */
export const buildReadsFirst = (
  grants: readonly Grant[],
  context: AbilityContext,
): Ability => {
  const seen: unknown[] = [];
  for (let i = 0; i < grants.length; i += 1) seen.push(grants[i]);
  return buildAbility(grants, context);
};

/** validateModel that drops role entries outside the catalogue instead of reporting them. */
export const validateSkipsScope = (model: Model): readonly string[] =>
  validateModel({
    ...model,
    roles: Object.fromEntries(
      Object.entries(model.roles).map(([role, keys]) => [
        role,
        keys.filter((k) => !k.endsWith(".approve.own")),
      ]),
    ),
  });

/** buildAbility whose error repeats the grants. */
export const buildEchoesInput = (
  grants: readonly Grant[],
  context: AbilityContext,
): Ability => {
  try {
    return buildAbility(grants, context);
  } catch {
    throw new Error(`bad grants ${JSON.stringify(grants)}`);
  }
};

/** A generated-files check that only looks for missing files. */
export const checkGeneratedPresenceOnly = async (
  dir: string,
): Promise<readonly string[]> =>
  (await checkGenerated(dir)).filter((p) => p.startsWith("missing:"));

/** Streams with the permission predicate removed. */
export const streamsUnfiltered = (model: Model) =>
  syncStreams(model).map((s) => ({
    ...s,
    query: s.query.replace(/permission = '[^']+' AND /g, ""),
  }));

/** RLS that calls a per-permission helper (ruling 2 forbids it). */
export const rlsHasGrant = (model: Model): string =>
  generateRls(model).replaceAll("app.has_project(", "app.has_grant('x', ");

const abilitySource = readFileSync(
  path.join(import.meta.dirname, "../src/ability.ts"),
  "utf8",
);
/** ability.ts with a Node built-in import. */
export const sourceImportsNode = `import { readFileSync } from "node:fs";\n${abilitySource}`;
/** ability.ts with an @bricx/money import (an edge above permissions). */
export const sourceImportsMoney = `import { fromMinor } from "@bricx/money/money";\n${abilitySource}`;
/** ability.ts with a value import of @bricx/i18n (only types are allowed). */
export const sourceImportsI18nValue = `import { MESSAGE_ARGS } from "@bricx/i18n/keys";\n${abilitySource}`;

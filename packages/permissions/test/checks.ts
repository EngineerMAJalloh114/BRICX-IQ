// Checks shared by the real code and the sabotage mutants (P3 rule 1). Each
// takes the implementation under test as a parameter and throws when it
// misbehaves; sabotage.test.ts runs every check on the real code (must
// pass) and on its mutant in mutants.ts (must throw).
import { expect } from "vitest";
import type { Ability, Grant, PermissionRecord } from "../src/ability.ts";
import type { AbilityContext } from "../src/ability.ts";
import type { Model, StreamDef } from "../src/generate.ts";
import type { SodAttempt, SodResult } from "../src/sod.ts";
import {
  CONTEXT,
  IN_SCOPE,
  ORG_A,
  ORG_B,
  OTHER_USER,
  PROJECT_1,
  PROJECT_2,
  USER,
  uuid,
} from "./helpers.ts";

export type Build = (
  grants: readonly Grant[],
  context: AbilityContext,
) => Ability;
export type Can = (
  ability: Ability,
  action: string,
  subject: string,
  record: PermissionRecord,
) => boolean;

const payment = (
  projectId: string,
  orgId: string = ORG_A,
): PermissionRecord => ({
  orgId,
  projectId,
  createdBy: OTHER_USER,
});

/** Ruling 1: a type-only or record-less check never allows. */
export function checkTypeOnlyDenied(build: Build, check: Can): void {
  const ability = build(
    [
      {
        permission: "finance.payment.approve",
        scope: "project",
        projectIds: [PROJECT_1] as never,
      },
    ],
    CONTEXT,
  );
  expect(check(ability, "approve", "finance.payment", payment(PROJECT_1))).toBe(
    true,
  );
  expect(check(ability, "approve", "finance.payment", payment(PROJECT_2))).toBe(
    false,
  );
  let allowed: unknown;
  try {
    allowed = check(ability, "approve", "finance.payment", undefined as never);
  } catch {
    allowed = false;
  }
  expect(allowed).toBe(false);
}

/** Every rule is pinned to the context's org. */
export function checkOrgPinned(build: Build, check: Can): void {
  const ability = build(
    [{ permission: "finance.payment.approve", scope: "org" }],
    CONTEXT,
  );
  expect(check(ability, "approve", "finance.payment", payment(PROJECT_1))).toBe(
    true,
  );
  expect(
    check(ability, "approve", "finance.payment", payment(PROJECT_1, ORG_B)),
  ).toBe(false);
}

/** Deny by default: no grant for an action means no access, manage is literal. */
export function checkDenyByDefault(build: Build, check: Can): void {
  const ability = build(
    [{ permission: "org.role.manage", scope: "org" }],
    CONTEXT,
  );
  expect(check(ability, "manage", "org.role", { orgId: ORG_A })).toBe(true);
  expect(check(ability, "read", "org.role", { orgId: ORG_A })).toBe(false);
  expect(check(ability, "read", "finance.payment", payment(PROJECT_1))).toBe(
    false,
  );
}

export type CheckSod = (attempt: SodAttempt) => SodResult;

/** Same actor + same chain + paired actions = violation; anything else passes. */
export function checkSodPairs(checkSod: CheckSod): void {
  const chain = uuid(100);
  const request = {
    chainId: chain,
    recordId: chain,
    recordType: "finance.payment",
    action: "request",
    actorId: USER,
  } as const;
  const approve = (actorId: string, chainId: string) =>
    checkSod({
      ...request,
      action: "approve",
      actorId,
      chainId,
      recordId: chainId,
      history: [request],
    } as unknown as SodAttempt);
  expect(approve(USER, chain).ok).toBe(false);
  expect(approve(OTHER_USER, chain).ok).toBe(true);
  expect(approve(USER, uuid(101)).ok).toBe(true);
}

/** Oversized grants are rejected before any element is read. */
export function checkGrantsBound(build: Build, limit: number): void {
  let reads = 0;
  const grant = { permission: "field.photo.read", scope: "org" } as const;
  const target: Grant[] = Array.from({ length: limit + 1 }, () => grant);
  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(t, key, receiver) as unknown;
    },
  });
  expect(() => build(proxy, CONTEXT)).toThrow();
  expect(reads).toBe(0);
}

export type Validate = (model: Model) => readonly string[];

/** A role entry at a scope the permission does not allow is a problem. */
export function checkRoleScope(validate: Validate, model: Model): void {
  const bad = structuredClone<Model>(model);
  bad.roles.foreman = [
    ...(bad.roles.foreman ?? []),
    "finance.payment.approve.own",
  ];
  expect(validate(model)).toEqual([]);
  expect(validate(bad)).toContain("role_entry_not_in_catalogue:foreman");
}

/** Error text never contains the input. */
export function checkNoInputInErrors(build: Build): void {
  const secret = "SECRET-INPUT-7f3a";
  let caught: unknown;
  try {
    build([{ permission: secret, scope: "org" } as never], CONTEXT);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(JSON.stringify(caught) + String(caught)).not.toContain(secret);
}

export type CheckGenerated = (dir: string) => Promise<readonly string[]>;

/** A stale committed file is reported. */
export async function checkStaleDetected(
  checkGenerated: CheckGenerated,
  staleDir: string,
): Promise<void> {
  expect(await checkGenerated(staleDir)).toEqual(["stale:rls.sql"]);
}

export type Streams = (model: Model) => readonly StreamDef[];

/** Every stream's query requires the resource's read permission at an allowed scope. */
export function checkStreamsFiltered(streams: Streams, model: Model): void {
  const all = streams(model);
  expect(all.length).toBeGreaterThan(0);
  for (const s of all) {
    const clauses =
      s.query.match(/permission = '[^']+' AND scope = '[a-z]+'/g) ?? [];
    expect(clauses).toEqual(
      s.scopes.map(
        (scope) => `permission = '${s.readPermission}' AND scope = '${scope}'`,
      ),
    );
    expect(s.query).not.toMatch(/\bOR TRUE\b|\b1\s*=\s*1\b/);
  }
}

export type Rls = (model: Model) => string;

/** RLS uses the ROADMAP primitives only (ruling 2). */
export function checkRlsPrimitives(rls: Rls, model: Model): void {
  const sql = rls(model);
  expect(sql).toContain("app.current_org()");
  expect(sql).toContain("app.has_project(");
  expect(sql).not.toMatch(/has_grant|has_permission/);
}

/** A source text imports only what the client-safe rule allows. */
export function checkClientSafeSource(
  scan: (code: string) => readonly [string, boolean][],
  allowed: RegExp,
  typeOnly: RegExp,
  code: string,
): void {
  for (const [spec, isType] of scan(code)) {
    if (isType && typeOnly.test(spec)) continue;
    expect(spec).toMatch(allowed);
  }
}

export const RECORD_IN_SCOPE = IN_SCOPE;

/**
 * The approved SoD pairs, written out by hand (independent of SOD_RULES):
 * the ROADMAP's three, the plan's seven and the three authoring-side
 * update pairs from the architect review of PR #39.
 */
export const EXPECTED_SOD_PAIRS = [
  ["finance.payment.request", "finance.payment.approve"],
  ["supply.purchase_order.create", "supply.goods_receipt.create"],
  ["finance.payment.record", "finance.reconciliation.create"],
  ["field.dailylog.create", "field.dailylog.approve"],
  ["field.attendance.create", "field.attendance.approve"],
  ["supply.material_request.create", "supply.material_request.approve"],
  ["supply.purchase_order.create", "supply.purchase_order.approve"],
  ["finance.budget.create", "finance.budget.approve"],
  ["finance.expenditure.create", "finance.expenditure.approve"],
  ["finance.change_order.create", "finance.change_order.approve"],
  ["field.dailylog.update", "field.dailylog.approve"],
  ["supply.material_request.update", "supply.material_request.approve"],
  ["finance.budget.update", "finance.budget.approve"],
] as const;

const sodStep = (permission: string, actorId: string, chainId: string) => ({
  chainId,
  recordId: chainId,
  recordType: permission.slice(0, permission.lastIndexOf(".")),
  action: permission.slice(permission.lastIndexOf(".") + 1),
  actorId,
});

/**
 * The exhaustive table over EXPECTED_SOD_PAIRS: for each pair and each
 * order, the same actor on the same chain is a violation; a different
 * actor, or the same actor on another chain, is allowed.
 */
export function checkSodTable(checkSod: CheckSod): void {
  const chain = uuid(100);
  const otherChain = uuid(101);
  for (const [first, second] of EXPECTED_SOD_PAIRS) {
    for (const [done, next] of [
      [first, second],
      [second, first],
    ] as const) {
      const run = (doer: string, historyChain: string) =>
        checkSod({
          ...sodStep(next, USER, chain),
          history: [sodStep(done, doer, historyChain)],
        } as unknown as SodAttempt);
      expect(run(USER, chain).ok, `${done} then ${next}`).toBe(false);
      expect(run(OTHER_USER, chain).ok, `${done} then ${next}`).toBe(true);
      expect(run(USER, otherChain).ok, `${done} then ${next}`).toBe(true);
    }
  }
}

/** validateModel reports a create or update action not paired with approve. */
export function checkAuthoringPaired(validate: Validate, model: Model): void {
  expect(validate(model)).toEqual([]);
  const bad = structuredClone<Model>(model);
  bad.sodRules = bad.sodRules.filter(
    (r) => r.id !== "finance.budget.update|finance.budget.approve",
  );
  expect(validate(bad)).toContain(
    "authoring_action_not_paired:finance.budget.update",
  );
}

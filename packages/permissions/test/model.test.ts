// validateModel reports every inconsistency a generator could otherwise
// turn into a wrong layer (added after the first green run to cover each
// problem code), and accessibleQuery fails closed on a rule without orgId.
import { describe, expect, it } from "vitest";
import { accessibleQuery } from "../src/ability.ts";
import { DEFAULT_MODEL, validateModel } from "../src/generate.ts";
import type { Model, ModelResource } from "../src/generate.ts";
import { abilityFromRules } from "../src/rules.ts";
import type { CaslRule } from "../src/rules.ts";

const copy = (): Model => structuredClone<Model>(DEFAULT_MODEL);
const resource = (m: Model, s: string): ModelResource => {
  const r = m.resources[s];
  if (r === undefined) throw new Error("fixture");
  return r;
};

describe("validateModel problem codes", () => {
  it.each([
    [
      "no_actions:field.photo",
      (m: Model) => {
        resource(m, "field.photo").actions = {};
        m.roles = Object.fromEntries(
          Object.entries(m.roles).map(([k, v]) => [
            k,
            v.filter((x) => !x.startsWith("field.photo.")),
          ]),
        );
        resource(m, "field.photo").synced = false;
      },
    ],
    [
      "unknown_scope:report.dashboard",
      (m: Model) => {
        resource(m, "report.dashboard").actions.read = [
          "org",
          "galaxy" as never,
        ];
      },
    ],
    [
      "site_scope_without_site_rows:report.dashboard",
      (m: Model) => {
        resource(m, "report.dashboard").actions.read = ["org", "site"];
      },
    ],
    [
      "narrow_scope_on_org_rows:finance.fx_rate",
      (m: Model) => {
        resource(m, "finance.fx_rate").actions.read = ["org", "project"];
      },
    ],
    [
      "action_without_org_scope:report.dashboard",
      (m: Model) => {
        resource(m, "report.dashboard").actions.export = ["project"];
      },
    ],
    [
      "synced_without_read:field.photo",
      (m: Model) => {
        delete resource(m, "field.photo").actions.read;
        m.roles = Object.fromEntries(
          Object.entries(m.roles).map(([k, v]) => [
            k,
            v.filter((x) => !x.startsWith("field.photo.read.")),
          ]),
        );
      },
    ],
    [
      "finance_synced:finance.budget",
      (m: Model) => {
        resource(m, "finance.budget").synced = true;
      },
    ],
    [
      "role_permission_twice:foreman",
      (m: Model) => {
        m.roles.foreman = [...(m.roles.foreman ?? []), "field.photo.read.org"];
      },
    ],
    [
      "sod_side_not_in_catalogue:x",
      (m: Model) => {
        m.sodRules.push({
          id: "x",
          first: "finance.payment.steal",
          second: "finance.payment.approve",
          source: "owner_review",
        });
      },
    ],
    [
      "sod_pair_invalid:y",
      (m: Model) => {
        m.sodRules.push({
          id: "y",
          first: "finance.payment.read",
          second: "finance.payment.approve",
          source: "owner_review",
        });
      },
    ],
    [
      "authoring_action_not_paired:finance.budget.update",
      (m: Model) => {
        m.sodRules = m.sodRules.filter(
          (r) => r.id !== "finance.budget.update|finance.budget.approve",
        );
      },
    ],
    [
      "authoring_action_not_paired:field.dailylog.create",
      (m: Model) => {
        m.sodRules = m.sodRules.filter(
          (r) => r.id !== "field.dailylog.create|field.dailylog.approve",
        );
      },
    ],
    [
      "authoring_action_not_paired:supply.material_request.update",
      (m: Model) => {
        m.sodRules = m.sodRules.filter(
          (r) =>
            r.id !==
            "supply.material_request.update|supply.material_request.approve",
        );
      },
    ],
  ] as const)("%s", (problem, mutate) => {
    const m = copy();
    mutate(m);
    expect(validateModel(m)).toContain(problem);
  });
});

describe("accessibleQuery fails closed", () => {
  it("throws on a rule without orgId", () => {
    const rule = {
      action: "read",
      subject: "field.photo",
      conditions: {},
    } as unknown as CaslRule;
    expect(() =>
      accessibleQuery(abilityFromRules([rule]), "read", "field.photo"),
    ).toThrow(expect.objectContaining({ code: "invalid_ability" }));
  });
});

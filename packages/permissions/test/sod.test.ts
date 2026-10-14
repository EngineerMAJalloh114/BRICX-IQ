// Segregation of duties (ROADMAP P3-05 step 4; architect rulings 5 and 6).
// A pure function over the record chain's history: an actor may not perform
// both sides of a pair on the same chain. chainId is the originating record
// (the PO for goods receipts, the payment for reconciliations, the record
// itself for request/approve). No override for anyone, owners included.
import { describe, expect, it } from "vitest";
import { PERMISSIONS, RESOURCES, SUBJECT_TYPES } from "../src/catalogue.ts";
import type { PermissionName } from "../src/catalogue.ts";
import { SOD_RULES, checkSod } from "../src/sod.ts";
import type { SodAttempt, SodHistoryEntry } from "../src/sod.ts";
import { OTHER_USER, USER, uuid } from "./helpers.ts";

const CHAIN = uuid(100);
const OTHER_CHAIN = uuid(101);

const split = (p: PermissionName) => ({
  recordType: p.slice(0, p.lastIndexOf(".")) as (typeof SUBJECT_TYPES)[number],
  action: p.slice(p.lastIndexOf(".") + 1),
});

function entry(
  permission: PermissionName,
  actorId: string,
  chainId = CHAIN,
  recordId = chainId,
): SodHistoryEntry {
  return {
    chainId,
    recordId,
    actorId,
    ...split(permission),
  } as SodHistoryEntry;
}

function attempt(
  permission: PermissionName,
  actorId: string,
  history: readonly SodHistoryEntry[],
  chainId = CHAIN,
  recordId = chainId,
): SodAttempt {
  return {
    chainId,
    recordId,
    actorId,
    history,
    ...split(permission),
  } as SodAttempt;
}

describe("the SoD rules as data", () => {
  it("are exactly the approved pairs (3 from the ROADMAP, the rest for owner review)", () => {
    expect(SOD_RULES.map((r) => [r.first, r.second, r.source])).toEqual([
      ["finance.payment.request", "finance.payment.approve", "roadmap"],
      [
        "supply.purchase_order.create",
        "supply.goods_receipt.create",
        "roadmap",
      ],
      ["finance.payment.record", "finance.reconciliation.create", "roadmap"],
      ["field.dailylog.create", "field.dailylog.approve", "owner_review"],
      ["field.attendance.create", "field.attendance.approve", "owner_review"],
      [
        "supply.material_request.create",
        "supply.material_request.approve",
        "owner_review",
      ],
      [
        "supply.purchase_order.create",
        "supply.purchase_order.approve",
        "owner_review",
      ],
      ["finance.budget.create", "finance.budget.approve", "owner_review"],
      [
        "finance.expenditure.create",
        "finance.expenditure.approve",
        "owner_review",
      ],
      [
        "finance.change_order.create",
        "finance.change_order.approve",
        "owner_review",
      ],
    ]);
  });

  it("every resource with an approve action has a request/approve pair", () => {
    for (const s of SUBJECT_TYPES) {
      if (!("approve" in RESOURCES[s].actions)) continue;
      expect(
        SOD_RULES.some((r) => r.second === `${s}.approve`),
        s,
      ).toBe(true);
    }
  });

  it("both sides are catalogue permissions, distinct, and never a read", () => {
    for (const r of SOD_RULES) {
      expect(PERMISSIONS).toContain(r.first);
      expect(PERMISSIONS).toContain(r.second);
      expect(r.first).not.toBe(r.second);
      expect(r.first.endsWith(".read") || r.second.endsWith(".read")).toBe(
        false,
      );
    }
  });
});

describe("exhaustive table: every pair x actor x order x chain", () => {
  const rows = SOD_RULES.flatMap((rule) =>
    (["same", "different"] as const).flatMap((actor) =>
      (["first-then-second", "second-then-first"] as const).flatMap((order) =>
        (["same", "other"] as const).map(
          (chain) => [rule.id, actor, order, chain] as const,
        ),
      ),
    ),
  );

  it("has 8 rows per rule", () => {
    expect(rows).toHaveLength(SOD_RULES.length * 8);
  });

  it.each(rows)("%s, %s actor, %s, %s chain", (id, actor, order, chain) => {
    const rule = SOD_RULES.find((r) => r.id === id);
    expect(rule).toBeDefined();
    if (rule === undefined) return;
    const [done, next] =
      order === "first-then-second"
        ? [rule.first, rule.second]
        : [rule.second, rule.first];
    const doer = actor === "same" ? USER : OTHER_USER;
    const historyChain = chain === "same" ? CHAIN : OTHER_CHAIN;
    const result = checkSod(
      attempt(
        next,
        USER,
        [entry(done, doer, historyChain, uuid(200))],
        CHAIN,
        uuid(201),
      ),
    );
    if (actor === "same" && chain === "same") {
      expect(result).toEqual({
        ok: false,
        code: "sod_violation",
        rule: id,
        key: "errors:permission.sod_violation",
      });
    } else {
      expect(result).toEqual({ ok: true });
    }
  });
});

describe("every other pair of permissions is allowed for the same actor on the same chain", () => {
  it("all catalogue permission pairs that are not a rule", () => {
    const paired = new Set(
      SOD_RULES.flatMap((r) => [
        `${r.first}|${r.second}`,
        `${r.second}|${r.first}`,
      ]),
    );
    let checked = 0;
    for (const a of PERMISSIONS) {
      for (const b of PERMISSIONS) {
        const result = checkSod(attempt(b, USER, [entry(a, USER)]));
        expect(result.ok, `${a} then ${b}`).toBe(!paired.has(`${a}|${b}`));
        checked += 1;
      }
    }
    expect(checked).toBe(PERMISSIONS.length ** 2);
  });
});

describe("the ROADMAP pairs across two record types (ruling 5)", () => {
  const PO = uuid(300);
  const RECEIPT = uuid(301);
  const PAYMENT = uuid(310);
  const RECONCILIATION = uuid(311);

  it("PO creator cannot receive the goods of that PO; another PO is fine", () => {
    const history = [entry("supply.purchase_order.create", USER, PO, PO)];
    expect(
      checkSod(
        attempt("supply.goods_receipt.create", USER, history, PO, RECEIPT),
      ).ok,
    ).toBe(false);
    expect(
      checkSod(
        attempt(
          "supply.goods_receipt.create",
          OTHER_USER,
          history,
          PO,
          RECEIPT,
        ),
      ).ok,
    ).toBe(true);
    expect(
      checkSod(
        attempt(
          "supply.goods_receipt.create",
          USER,
          history,
          uuid(302),
          RECEIPT,
        ),
      ).ok,
    ).toBe(true);
  });

  it("the receiver of goods cannot create the PO afterwards on the same chain", () => {
    const history = [entry("supply.goods_receipt.create", USER, PO, RECEIPT)];
    expect(
      checkSod(attempt("supply.purchase_order.create", USER, history, PO, PO))
        .ok,
    ).toBe(false);
  });

  it("whoever recorded a payment cannot reconcile it", () => {
    const history = [entry("finance.payment.record", USER, PAYMENT, PAYMENT)];
    expect(
      checkSod(
        attempt(
          "finance.reconciliation.create",
          USER,
          history,
          PAYMENT,
          RECONCILIATION,
        ),
      ),
    ).toEqual({
      ok: false,
      code: "sod_violation",
      rule: "finance.payment.record|finance.reconciliation.create",
      key: "errors:permission.sod_violation",
    });
    expect(
      checkSod(
        attempt(
          "finance.reconciliation.create",
          OTHER_USER,
          history,
          PAYMENT,
          RECONCILIATION,
        ),
      ).ok,
    ).toBe(true);
  });

  it("requester cannot approve the same record, approver of another record is fine", () => {
    const history = [entry("finance.payment.request", USER, PAYMENT, PAYMENT)];
    expect(
      checkSod(attempt("finance.payment.approve", USER, history, PAYMENT)).ok,
    ).toBe(false);
    expect(
      checkSod(attempt("finance.payment.approve", USER, history, uuid(320))).ok,
    ).toBe(true);
  });

  it("a long history is scanned in full", () => {
    const filler = Array.from({ length: 999 }, (_, i) =>
      entry("field.photo.create", OTHER_USER, CHAIN, uuid(1000 + i)),
    );
    const history = [...filler, entry("finance.payment.request", USER)];
    expect(checkSod(attempt("finance.payment.approve", USER, history)).ok).toBe(
      false,
    );
  });
});

describe("input validation, codes only", () => {
  it("rejects bad ids, unknown types or actions, and bad history entries", () => {
    const good = attempt("finance.payment.approve", USER, []);
    const bad: unknown[] = [
      undefined,
      null,
      { ...good, actorId: "user" },
      { ...good, chainId: CHAIN.toUpperCase() },
      { ...good, recordId: 1 },
      { ...good, recordType: "finance.unknown" },
      { ...good, action: "steal" },
      { ...good, history: "none" },
      { ...good, history: [null] },
      {
        ...good,
        history: [{ ...entry("finance.payment.request", USER), actorId: "x" }],
      },
      {
        ...good,
        history: [
          { ...entry("finance.payment.request", USER), action: "steal" },
        ],
      },
      { ...good, extra: true },
    ];
    for (const input of bad) {
      expect(() => checkSod(input as SodAttempt)).toThrow(
        expect.objectContaining({ code: "invalid_sod_input" }),
      );
    }
  });
});

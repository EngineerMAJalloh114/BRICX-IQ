// Region configuration's service (P6-03, ADR 0073), on the request's org
// (TxRunner, RLS):
// - readEffective(projectId?): the organisation's columns, its org row and
//   the project's row in one query (@bricx/db/region-configs, C2), resolved
//   by @bricx/domain's resolveRegionConfig(): each field's value and the
//   layer that set it. An unknown project has no row: the org's values.
// - readLayer(projectId | null): the stored row of one layer, every field
//   null (and no timestamps) while it has none.
// - updateLayer(projectId | null, body): the DTO has refused an empty body
//   and the fields the layer may not hold (C1, C3). Only fields whose value
//   differs from the stored one are written; none: 200 with the row as it
//   is, nothing written, no audit event (C1). Otherwise the row is
//   inserted or updated and ONE audit event names the changed fields,
//   never their values (C1): org.region_config.update (org row) or
//   org.region_config.project_update (a project's). A CHECK violation
//   (23514, the backstop behind the DTO) is 422 validation_failed, never
//   a 500 (C3).
// - P6-04 (ADR 0074, D9; the P6-03 Also line): a changed paymentAdapters
//   is checked in full against the adapter registry, every id a payment
//   adapter (a stale stored id must be removed to change the list), and a
//   changed accountingAdapter must be an accounting adapter. An unknown or
//   wrong-kind id is 422 validation_failed, issue unknown_adapter at the
//   field's path, never the value, before the write: nothing is written or
//   audited. The list's issue names the field, not an index: the DTO has
//   sorted the list, so an index would not be the client's. A field equal to its stored value is not re-checked, so a
//   no-change body repeating a stale id stays 200 (C1); null is always
//   allowed. Reads return stored ids as they are (D10).
import type { AdapterRegistry } from "@bricx/adapters/registry";
import { sqlstateOf } from "@bricx/db/database";
import {
  REGION_CONFIG_FIELD_NAMES,
  REGION_CONFIG_SUBJECT,
  type RegionConfigFields,
  type RegionConfigRow,
  readRegionConfig,
  readRegionLayers,
  writeRegionConfig,
} from "@bricx/db/region-configs";
import {
  type RegionConfigLayer as DomainLayer,
  resolveRegionConfig,
} from "@bricx/domain/region-config";
import type { UnitSystemName } from "@bricx/domain/regions";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import {
  errorEnvelope,
  type EnvelopeIssue,
} from "@bricx/validation/error-envelope";
import { issueKey } from "@bricx/validation/codes";
import { Inject, Injectable } from "@nestjs/common";
import { ADAPTER_REGISTRY } from "../../common/adapters/adapters.module.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError, ValidationError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import { requireIdentity } from "../sessions/public-api.js";
import type {
  EffectiveRegionConfigData,
  RegionConfigLayerData,
  UpdateOrgRegionConfigInput,
  UpdateProjectRegionConfigInput,
} from "./region-config.dto.js";

/** The transactions the service opens (a fake in the unit tests). */
export type RegionConfigTxRunner = Pick<TxRunner, "run">;
/** The audit writer (a fake in the unit tests). */
export type RegionConfigAudit = Pick<AuditService, "record">;

/** The adapter ids the service checks writes against (a fake in the unit tests). */
export type RegionConfigAdapters = Pick<AdapterRegistry, "has">;

/** What the controller calls. */
export type RegionConfigPort = Pick<
  RegionConfigService,
  "readEffective" | "readLayer" | "updateLayer"
>;

const CHECK_VIOLATION = "23514";

const unitsOf = (value: string | null): UnitSystemName | null =>
  value === null ? null : value === "us_customary" ? "us_customary" : "metric";

const toLayer = (row: RegionConfigRow | undefined): DomainLayer =>
  row === undefined ? {} : { ...row, units: unitsOf(row.units) };

const emptyLayer = (projectId: string | null): RegionConfigLayerData =>
  ({
    projectId,
    ...Object.fromEntries(REGION_CONFIG_FIELD_NAMES.map((f) => [f, null])),
    createdAt: null,
    updatedAt: null,
  }) as RegionConfigLayerData;

/** A list as a plain copy (the response is not the stored array). */
const copy = (value: unknown): unknown =>
  Array.isArray(value) ? value.slice() : value;

const toData = (
  row: RegionConfigRow | undefined,
  projectId: string | null,
): RegionConfigLayerData =>
  row === undefined
    ? emptyLayer(projectId)
    : ({
        projectId: row.projectId,
        ...Object.fromEntries(
          REGION_CONFIG_FIELD_NAMES.map((f) => [f, copy(row[f])]),
        ),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } as RegionConfigLayerData);

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const unknownAdapter = (path: EnvelopeIssue["path"]): EnvelopeIssue => ({
  path,
  code: "unknown_adapter",
  key: issueKey("unknown_adapter"),
});

/** The unknown_adapter issues of the changed adapter fields (D9). */
function adapterIssues(
  changes: Partial<Record<keyof RegionConfigFields, unknown>>,
  adapters: RegionConfigAdapters,
): EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];
  const payment = changes.paymentAdapters;
  if (
    Array.isArray(payment) &&
    !payment.every(
      (id: unknown) => typeof id === "string" && adapters.has("payment", id),
    )
  ) {
    issues.push(unknownAdapter(["paymentAdapters"]));
  }
  const accounting = changes.accountingAdapter;
  if (
    typeof accounting === "string" &&
    !adapters.has("accounting", accounting)
  ) {
    issues.push(unknownAdapter(["accountingAdapter"]));
  }
  return issues;
}

@Injectable()
export class RegionConfigService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: RegionConfigTxRunner,
    @Inject(AuditService) private readonly audit: RegionConfigAudit,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ADAPTER_REGISTRY) private readonly adapters: RegionConfigAdapters,
  ) {
    this.ids = createUuidV7Generator({ clock });
  }

  async readEffective(projectId?: string): Promise<EffectiveRegionConfigData> {
    const { orgId } = requireIdentity();
    const layers = await this.runner.run((tx) =>
      readRegionLayers(tx, orgId, projectId),
    );
    if (layers === undefined) throw new ApiError("not_found");
    const resolved = resolveRegionConfig({
      organization: {
        ...layers.organization,
        units: unitsOf(layers.organization.units) ?? "metric",
      },
      org: toLayer(layers.org),
      project: toLayer(layers.project),
    });
    return {
      projectId: projectId ?? null,
      ...resolved,
      paymentAdapters: {
        ...resolved.paymentAdapters,
        value: [...resolved.paymentAdapters.value],
      },
    };
  }

  async readLayer(projectId: string | null): Promise<RegionConfigLayerData> {
    const { orgId } = requireIdentity();
    const row = await this.runner.run((tx) =>
      readRegionConfig(tx, orgId, projectId),
    );
    return toData(row, projectId);
  }

  async updateLayer(
    projectId: string | null,
    input: UpdateOrgRegionConfigInput | UpdateProjectRegionConfigInput,
  ): Promise<RegionConfigLayerData> {
    const { orgId } = requireIdentity();
    return this.runner.run(async (tx) => {
      const before = await readRegionConfig(tx, orgId, projectId);
      const changes: Partial<Record<keyof RegionConfigFields, unknown>> = {};
      for (const field of REGION_CONFIG_FIELD_NAMES) {
        const value: unknown = Reflect.get(input, field);
        if (value === undefined) continue;
        if (same(value, before === undefined ? null : before[field])) continue;
        changes[field] = value;
      }
      const fields = Object.keys(changes);
      if (fields.length === 0) return toData(before, projectId);
      const issues = adapterIssues(changes, this.adapters);
      if (issues.length > 0) {
        throw new ValidationError({
          ...errorEnvelope("validation_failed"),
          issues,
        });
      }
      let row: RegionConfigRow;
      try {
        row = await writeRegionConfig(tx, {
          id: this.ids.next(),
          orgId,
          projectId,
          changes: changes as Partial<RegionConfigFields>,
          now: new Date(this.clock.now()).toISOString(),
        });
      } catch (error) {
        if (sqlstateOf(error) === CHECK_VIOLATION) {
          throw new ApiError("validation_failed");
        }
        throw error;
      }
      await this.audit.record(tx, {
        action:
          projectId === null
            ? `${REGION_CONFIG_SUBJECT}.update`
            : `${REGION_CONFIG_SUBJECT}.project_update`,
        entityType: REGION_CONFIG_SUBJECT,
        entityId: row.id,
        after: { fields },
      });
      return toData(row, projectId);
    });
  }
}

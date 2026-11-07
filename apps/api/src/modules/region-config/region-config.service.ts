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
import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
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

@Injectable()
export class RegionConfigService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: RegionConfigTxRunner,
    @Inject(AuditService) private readonly audit: RegionConfigAudit,
    @Inject(CLOCK) private readonly clock: Clock,
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

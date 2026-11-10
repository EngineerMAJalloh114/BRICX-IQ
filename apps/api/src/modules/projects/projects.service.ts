// Projects' service (P6-05, ADR 0075; owner conditions C1, C3, C5, C7,
// C8). Each call: the identity, then one TxRunner transaction as
// bricx_app under RLS. In it, in this order:
// - visibility (C5): a project the transaction does not see, or one the
//   caller may not read, is 404, the same as an unknown id;
// - the action on that project (update, or archive for a move to
//   archived, C3): 403 when refused;
// - state: an archived project is read-only (409); currency, reporting
//   currency and timezone change only in draft (C1, 409); the move must
//   be one the machine allows (409);
// - the write, then ONE audit event, the last statement (ADR 0055):
//   project.project.create, .update (after: the changed fields' names,
//   never values) or .status (before/after: the status).
// create(): project.project.create on the new record (403); the code is
// unique per org regardless of case (409, C7); currency, reporting
// currency and timezone default from the organisation's effective
// configuration (@bricx/domain's resolver over the org's layers); nobody
// becomes a member (D7, C5): an org-scope holder reads it, others are
// assigned through the project members routes.
// The contract value (C8) is answered, and may be set, only to callers
// holding project.project.update on that project; others read null and
// a write from them is 403. Its amount never reaches the audit log.
// A PATCH with nothing different is 200, nothing written, no event.
// Start after end is 422 at endDate. A CHECK violation (the backstop
// behind the DTO) is 422, the guard trigger's refusal (P6004) 409.
import { sqlstateOf } from "@bricx/db/database";
import type { Tx } from "@bricx/db/database";
import { readRegionLayers } from "@bricx/db/region-configs";
import {
  type ProjectStatus,
  nextProjectStatus,
  projectStatusAction,
} from "@bricx/domain/project-status";
import { resolveRegionConfig } from "@bricx/domain/region-config";
import type { UnitSystemName } from "@bricx/domain/regions";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { errorEnvelope } from "@bricx/validation/error-envelope";
import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock.js";
import type { Identity } from "../../common/db/request-context.js";
import {
  INVITATION_REVOKER,
  INVITATION_SUBJECT,
  type InvitationRevoker,
} from "../../common/db/invitation-revoker.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError, ValidationError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import {
  type AuditRecorder,
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import {
  type CreateProjectInput,
  type ListProjectsInput,
  type ProjectData,
  type UpdateProjectInput,
  decodeCursor,
  encodeCursor,
} from "./projects.dto.js";
import {
  PROJECT_SUBJECT,
  canProject,
  projectReadFilters,
  projectRecord,
} from "./projects.policies.js";
import {
  type ProjectFields,
  type ProjectRow,
  ProjectsRepository,
} from "./projects.repository.js";

const CHECK_VIOLATION = "23514";
/** bricx.projects_guard's refusal (migration 0011). */
const PROJECT_GUARD = "P6004";

/** The fields locked once the project leaves draft (C1). */
const LOCKED_FIELDS = ["currency", "reportingCurrency", "timezone"] as const;

export interface ProjectPageData {
  readonly items: ProjectData[];
  readonly nextCursor: string | null;
}

/** What the controller calls. */
export type ProjectsPort = Pick<
  ProjectsService,
  "create" | "get" | "list" | "update" | "move"
>;

/** 422 validation_failed with one invalid_value issue at `path`. */
function invalid(path: readonly string[]): never {
  throw new ValidationError({
    ...errorEnvelope("validation_failed"),
    issues: [
      {
        path: [...path],
        code: "invalid_value",
        key: "validation:invalid_value",
      },
    ],
  });
}

/** A write's database refusals as API errors (else rethrown). */
function refuseWrite(error: unknown): never {
  const state = sqlstateOf(error);
  if (state === CHECK_VIOLATION) throw new ApiError("validation_failed");
  if (state === PROJECT_GUARD) throw new ApiError("request.conflict");
  throw error;
}

const STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "active",
  "on_hold",
  "completed",
  "archived",
]);
const statusOf = (value: string): ProjectStatus => {
  /* v8 ignore next -- the table's CHECK holds the five statuses */
  if (!STATUSES.has(value)) throw new Error("unknown project status");
  return value as ProjectStatus;
};

const unitsOf = (value: string): UnitSystemName =>
  value === "us_customary" ? "us_customary" : "metric";

/** The stored contract value (minor units, currency) as patch columns. */
const contractColumns = (
  value: CreateProjectInput["contractValue"],
): Pick<ProjectFields, "contractValueMinor" | "contractValueCurrency"> =>
  value === undefined || value === null
    ? { contractValueMinor: null, contractValueCurrency: null }
    : {
        contractValueMinor: value.amount,
        contractValueCurrency: String(value.currency),
      };

@Injectable()
export class ProjectsService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(ProjectsRepository)
    private readonly repository: ProjectsRepository,
    @Inject(AuditService) private readonly audit: AuditRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INVITATION_REVOKER)
    private readonly revokeInvitations: InvitationRevoker,
  ) {
    this.ids = createUuidV7Generator({ clock });
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** The row as answered: the contract value only for an update-key holder (C8). */
  static present(identity: Identity, row: ProjectRow): ProjectData {
    const record = projectRecord(identity.orgId, row);
    const minor = row.contractValueMinor;
    const currency = row.contractValueCurrency;
    const contractValue =
      minor !== null &&
      currency !== null &&
      canProject(identity, "update", record)
        ? { amount: minor, currency }
        : null;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      clientName: row.clientName,
      status: statusOf(row.status),
      currency: row.currency,
      reportingCurrency: row.reportingCurrency,
      timezone: row.timezone,
      startDate: row.startDate,
      endDate: row.endDate,
      contractValue,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }

  /** The project the caller may read, locked for a write when asked; else 404 (C5). */
  private async readable(
    tx: Tx,
    identity: Identity,
    id: string,
    lock = false,
  ): Promise<ProjectRow> {
    const row = lock
      ? await this.repository.lockProject(tx, identity.orgId, id)
      : await this.repository.findProject(tx, identity.orgId, id);
    if (
      row === undefined ||
      !canProject(identity, "read", projectRecord(identity.orgId, row))
    ) {
      throw new ApiError("not_found");
    }
    return row;
  }

  /** A new draft project (project.project.create). */
  create(input: CreateProjectInput): Promise<ProjectData> {
    const identity = requireIdentity();
    const id = this.ids.next();
    const record = projectRecord(identity.orgId, {
      id,
      createdBy: identity.userId,
    });
    if (!canProject(identity, "create", record)) {
      throw new ApiError("forbidden");
    }
    const contract = input.contractValue ?? null;
    if (contract !== null && !canProject(identity, "update", record)) {
      throw new ApiError("forbidden");
    }
    const startDate = input.startDate ?? null;
    const endDate = input.endDate ?? null;
    if (startDate !== null && endDate !== null && startDate > endDate) {
      invalid(["endDate"]);
    }
    return this.runner.run(async (tx) => {
      const effective = await this.orgDefaults(tx, identity.orgId);
      const now = this.now();
      let row: ProjectRow;
      try {
        row = await this.repository.insertProject(tx, {
          id,
          orgId: identity.orgId,
          code: input.code,
          name: input.name,
          clientName: input.clientName ?? null,
          currency: input.currency ?? effective.currency,
          reportingCurrency:
            input.reportingCurrency ?? effective.reportingCurrency,
          timezone: input.timezone ?? effective.timezone,
          startDate,
          endDate,
          ...contractColumns(contract),
          createdBy: identity.userId,
          now,
        });
      } catch (error) {
        refuseWrite(error);
      }
      await this.audit.record(tx, {
        action: `${PROJECT_SUBJECT}.create`,
        entityType: PROJECT_SUBJECT,
        entityId: row.id,
        after: {
          code: row.code,
          status: row.status,
          currency: row.currency,
          reportingCurrency: row.reportingCurrency,
          timezone: row.timezone,
        },
      });
      return ProjectsService.present(identity, row);
    });
  }

  /** The organisation's effective currency, reporting currency and timezone. */
  private async orgDefaults(
    tx: Tx,
    orgId: string,
  ): Promise<{
    readonly currency: string;
    readonly reportingCurrency: string;
    readonly timezone: string;
  }> {
    const layers = await readRegionLayers(tx, orgId);
    /* v8 ignore next -- the request's own organisation is always visible */
    if (layers === undefined) throw new ApiError("not_found");
    const units = (value: string | null) =>
      value === null ? null : unitsOf(value);
    const resolved = resolveRegionConfig({
      organization: {
        ...layers.organization,
        units: unitsOf(layers.organization.units),
      },
      org:
        layers.org === undefined
          ? {}
          : { ...layers.org, units: units(layers.org.units) },
    });
    return {
      currency: resolved.currency.value,
      reportingCurrency: resolved.reportingCurrency.value,
      timezone: resolved.timezone.value,
    };
  }

  /** One project (404 when unseen or unreadable, C5). */
  get(id: string): Promise<ProjectData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) =>
      ProjectsService.present(identity, await this.readable(tx, identity, id)),
    );
  }

  /** A page of the projects the caller may read, newest first (C5). */
  async list(query: ListProjectsInput): Promise<ProjectPageData> {
    const identity = requireIdentity();
    const filters = projectReadFilters(identity);
    const before =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rows = await this.runner.run((tx) =>
      this.repository.listProjects(tx, identity.orgId, {
        filters,
        before,
        limit: query.limit + 1,
        status: query.status,
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ProjectsService.present(identity, row)),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor(last.id)
          : null,
    };
  }

  /** Changes the given fields (project.project.update on it). */
  update(id: string, input: UpdateProjectInput): Promise<ProjectData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const row = await this.readable(tx, identity, id, true);
      if (!canProject(identity, "update", projectRecord(identity.orgId, row))) {
        throw new ApiError("forbidden");
      }
      if (row.status === "archived") throw new ApiError("request.conflict");
      const changes: Partial<Record<keyof ProjectFields, unknown>> = {};
      const fields: string[] = [];
      const set = (
        name: string,
        columns: Partial<Record<keyof ProjectFields, unknown>>,
      ) => {
        fields.push(name);
        Object.assign(changes, columns);
      };
      const scalar = [
        "code",
        "name",
        "clientName",
        "currency",
        "reportingCurrency",
        "timezone",
        "startDate",
        "endDate",
      ] as const;
      for (const field of scalar) {
        const value = input[field];
        if (value === undefined || value === row[field]) continue;
        set(field, { [field]: value });
      }
      if (input.contractValue !== undefined) {
        const next = contractColumns(input.contractValue);
        const same =
          (next.contractValueMinor === null
            ? null
            : String(next.contractValueMinor)) === row.contractValueMinor &&
          next.contractValueCurrency === row.contractValueCurrency;
        if (!same) set("contractValue", next);
      }
      if (fields.length === 0) return ProjectsService.present(identity, row);
      if (
        row.status !== "draft" &&
        LOCKED_FIELDS.some((field) => fields.includes(field))
      ) {
        throw new ApiError("request.conflict");
      }
      const startDate =
        input.startDate === undefined ? row.startDate : input.startDate;
      const endDate = input.endDate === undefined ? row.endDate : input.endDate;
      if (startDate !== null && endDate !== null && startDate > endDate) {
        invalid(["endDate"]);
      }
      let updated: ProjectRow;
      try {
        updated = await this.repository.updateProject(
          tx,
          identity.orgId,
          id,
          changes as Partial<ProjectFields>,
          this.now(),
        );
      } catch (error) {
        refuseWrite(error);
      }
      await this.audit.record(tx, {
        action: `${PROJECT_SUBJECT}.update`,
        entityType: PROJECT_SUBJECT,
        entityId: id,
        after: { fields: [...fields].sort() },
      });
      return ProjectsService.present(identity, updated);
    });
  }

  /** Moves the status (C3): archive needs project.project.archive, any other move update. */
  move(id: string, to: ProjectStatus): Promise<ProjectData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const row = await this.readable(tx, identity, id, true);
      const action = projectStatusAction(to);
      if (!canProject(identity, action, projectRecord(identity.orgId, row))) {
        throw new ApiError("forbidden");
      }
      const next = nextProjectStatus(row.status, to);
      if (!next.ok) throw new ApiError("request.conflict");
      const now = this.now();
      let updated: ProjectRow;
      try {
        updated = await this.repository.updateProject(
          tx,
          identity.orgId,
          id,
          {
            status: next.value,
            ...(next.value === "archived" ? { archivedAt: now } : {}),
          },
          now,
        );
      } catch (error) {
        refuseWrite(error);
      }
      // P6-06 (ADR 0077, D14): archiving a project revokes its pending
      // invitations in this transaction, one org.invitation.revoke each.
      if (next.value === "archived") {
        const revoked = await this.revokeInvitations(tx, {
          orgId: identity.orgId,
          scope: { projectId: id },
          reason: "project_archived",
          by: identity.userId,
          now,
        });
        for (const invitation of revoked) {
          await this.audit.record(tx, {
            action: `${INVITATION_SUBJECT}.revoke`,
            entityType: INVITATION_SUBJECT,
            entityId: invitation.id,
            before: { status: "pending", projectId: invitation.projectId },
            after: {
              status: "revoked",
              projectId: invitation.projectId,
              reason: invitation.revokeReason,
            },
          });
        }
      }
      await this.audit.record(tx, {
        action: `${PROJECT_SUBJECT}.status`,
        entityType: PROJECT_SUBJECT,
        entityId: id,
        before: { status: row.status },
        after: { status: updated.status },
      });
      return ProjectsService.present(identity, updated);
    });
  }
}

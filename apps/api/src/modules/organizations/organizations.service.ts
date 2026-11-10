// Organisations' service (P6-02, ADR 0072).
// Create (POST /v1/organizations, @SignedIn, D11), for the signed-in user,
// with the org id stable across retries (owner ruling R4, D12, condition
// C2). The body was validated whole by the DTO (C2), then:
// 0. no directory writer: 503 server_unavailable (D3); a missing or
//    malformed Idempotency-Key: 400 idempotency.key_missing / key_invalid;
//    a reserved slug: 409 organization.slug_unavailable (D14, R5);
//    nothing is written by any of these;
// 1. Tx A, as the user in the candidate org: the per-user advisory lock;
//    the attempt under (user, SHA-256 of the key) is read. Another body
//    under the key is 422 idempotency.key_reused; a committed attempt
//    replays the organisation (201); a refused one replays the 409; a
//    pending one resumes with its org id. A new key: past
//    ORGS_MAX_CREATED_PER_USER pending + committed attempts is 409
//    request.conflict (D1, D13: archived organisations count); else the
//    attempt is inserted, pending, with a new UUIDv7 org id;
// 2. the directory reservation (registerOrganization, ADR 0071: before
//    the cell commits): slug_taken settles the attempt refused and answers
//    the same 409 as a reserved slug; the directory unreachable is 503
//    and the attempt stays pending (the retry resumes it);
// 3. Tx B, as the user in the new org: the attempt is locked; if a
//    parallel retry already committed it, the organisation is replayed;
//    else @bricx/db/organizations' createOrganization() (the row with
//    data_region = CELL_ID, the bootstrap, the audit event
//    org.organization.create, last but for the settle) and the attempt
//    committed, in one transaction.
// Read, update and archive act on the request's org (TxRunner): PATCH
// changes the editable fields and records org.organization.update (the
// changed fields, before and after); archive sets archived_at once
// (org.organization.archive): the org is then 404 everywhere but GET
// /current (D6/D16). Restore is a runbook step (ADR 0072).
import { createHash } from "node:crypto";
import type { DirectoryWriter } from "@bricx/db/directory";
import { DirectoryRegistrationError } from "@bricx/db/directory";
import { IDEMPOTENCY_KEY_PATTERN } from "@bricx/db/idempotency";
import {
  ORGANIZATION_SUBJECT,
  type OrganizationRow,
  createOrganization,
  readOrganization,
} from "@bricx/db/organizations";
import { unitSystemFor } from "@bricx/domain/regions";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { isReservedSlug } from "@bricx/validation/reserved-slugs";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { signedInUser } from "../../common/auth/signed-in.decorator.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import {
  NoTenantContextError,
  currentRequestContext,
} from "../../common/db/request-context.js";
import {
  INVITATION_REVOKER,
  INVITATION_SUBJECT,
  type InvitationRevoker,
} from "../../common/db/invitation-revoker.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import { requestFingerprint } from "../../common/idempotency/fingerprint.js";
import { AuditService } from "../audit/public-api.js";
import { requireIdentity } from "../sessions/public-api.js";
import type {
  CreateOrganizationInput,
  OrganizationData,
  UpdateOrganizationInput,
} from "./organizations.dto.js";
import { OrganizationsRepository } from "./organizations.repository.js";

/** Injection tokens: this cell's id, the directory writer, the cap. */
export const CELL_ID = Symbol("CELL_ID");
export const ORGS_DIRECTORY_WRITER = Symbol("ORGS_DIRECTORY_WRITER");
export const ORGS_MAX_CREATED_PER_USER = Symbol("ORGS_MAX_CREATED_PER_USER");

type Outcome =
  | { readonly kind: "replay"; readonly orgId: string }
  | { readonly kind: "refused" }
  | { readonly kind: "proceed"; readonly orgId: string };

const toData = (row: OrganizationRow): OrganizationData => ({
  ...row,
  units: row.units === "us_customary" ? "us_customary" : "metric",
});

/** The transactions the service opens (a fake in the unit tests). */
export type OrganizationsTxRunner = Pick<TxRunner, "run" | "runSignedIn">;
/** The audit writer (a fake in the unit tests). */
export type OrganizationsAudit = Pick<AuditService, "record">;

/** What the controller calls. */
export type OrganizationsPort = Pick<
  OrganizationsService,
  "create" | "readCurrent" | "updateCurrent" | "archiveCurrent"
>;

@Injectable()
export class OrganizationsService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: OrganizationsTxRunner,
    @Inject(OrganizationsRepository)
    private readonly repository: OrganizationsRepository,
    @Inject(AuditService) private readonly audit: OrganizationsAudit,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CELL_ID) private readonly cellId: string,
    @Inject(ORGS_DIRECTORY_WRITER)
    private readonly writer: DirectoryWriter | undefined,
    @Inject(ORGS_MAX_CREATED_PER_USER) private readonly maxCreated: number,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(INVITATION_REVOKER)
    private readonly revokeInvitations: InvitationRevoker,
  ) {
    this.ids = createUuidV7Generator({ clock });
    this.logger.setContext("organizations");
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  async create(
    input: CreateOrganizationInput,
    key: string | string[] | undefined,
  ): Promise<OrganizationData> {
    const user = signedInUser();
    if (user === undefined) throw new NoTenantContextError();
    const writer = this.writer;
    if (writer === undefined) throw new ApiError("server_unavailable");
    if (key === undefined) throw new ApiError("idempotency.key_missing");
    if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new ApiError("idempotency.key_invalid");
    }
    if (isReservedSlug(input.slug)) {
      throw new ApiError("organization.slug_unavailable");
    }
    const units = input.units ?? this.unitsOf(input.country);
    const body = { ...input, units, brandColor: input.brandColor ?? null };
    const keyHash = createHash("sha256").update(key, "utf8").digest();
    const requestHash = requestFingerprint({ query: {}, body });
    const userId = user.userId;

    // Tx A: the lock, the attempt, the cap.
    const candidate = this.ids.next();
    const outcome = await this.runner.runSignedIn<Outcome>(
      candidate,
      async (tx) => {
        await this.repository.lockUser(tx, userId);
        const existing = await this.repository.findAttempt(tx, userId, keyHash);
        if (existing !== undefined) {
          if (!existing.requestHash.equals(requestHash)) {
            throw new ApiError("idempotency.key_reused");
          }
          if (existing.state === "committed") {
            return { kind: "replay", orgId: existing.orgId };
          }
          if (existing.state === "refused") return { kind: "refused" };
          return { kind: "proceed", orgId: existing.orgId };
        }
        if (
          (await this.repository.countCounted(tx, userId)) >= this.maxCreated
        ) {
          throw new ApiError("request.conflict");
        }
        await this.repository.insertAttempt(tx, {
          userId,
          keyHash,
          requestHash,
          orgId: candidate,
          slug: input.slug,
          now: this.now(),
        });
        return { kind: "proceed", orgId: candidate };
      },
    );
    if (outcome.kind === "refused") {
      throw new ApiError("organization.slug_unavailable");
    }
    if (outcome.kind === "replay") return this.readAs(outcome.orgId);
    const orgId = outcome.orgId;

    // The reservation, before the cell commits (ADR 0071).
    try {
      await writer.registerOrganization({
        orgId,
        slug: input.slug,
        cellId: this.cellId,
      });
    } catch (error) {
      if (
        error instanceof DirectoryRegistrationError &&
        error.code === "slug_taken"
      ) {
        await this.runner.runSignedIn(orgId, (tx) =>
          this.repository.settleAttempt(
            tx,
            userId,
            keyHash,
            "refused",
            this.now(),
          ),
        );
        throw new ApiError("organization.slug_unavailable");
      }
      // Any other refusal is a deployment fault (an unknown cell), and an
      // unreachable directory is temporary: the attempt stays pending.
      this.logger.warn(
        {
          orgId,
          code:
            error instanceof DirectoryRegistrationError
              ? error.code
              : "directory_unavailable",
        },
        "organizations.directory_failed",
      );
      throw new ApiError("server_unavailable");
    }

    // Tx B: the organisation, its owner and the attempt, together.
    return this.runner.runSignedIn(orgId, async (tx) => {
      const attempt = await this.repository.findAttempt(
        tx,
        userId,
        keyHash,
        true,
      );
      if (attempt?.state === "committed") {
        const row = await readOrganization(tx, orgId);
        if (row === undefined) throw new ApiError("not_found");
        return toData(row);
      }
      const now = this.now();
      const { organization } = await createOrganization(
        tx,
        { clock: this.clock, ids: this.ids, origin: this.origin() },
        {
          id: orgId,
          slug: input.slug,
          legalName: input.legalName,
          country: input.country,
          defaultCurrency: input.defaultCurrency,
          defaultLanguage: input.defaultLanguage,
          timezone: input.timezone,
          units,
          dataRegion: this.cellId,
          brandColor: body.brandColor,
          ownerId: userId,
          now,
        },
      );
      await this.repository.settleAttempt(
        tx,
        userId,
        keyHash,
        "committed",
        now,
      );
      return toData(organization);
    });
  }

  async readCurrent(): Promise<OrganizationData> {
    const identity = requireIdentity();
    const row = await this.runner.run((tx) =>
      readOrganization(tx, identity.orgId),
    );
    if (row === undefined) throw new ApiError("not_found");
    return toData(row);
  }

  async updateCurrent(
    input: UpdateOrganizationInput,
  ): Promise<OrganizationData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const before = await readOrganization(tx, identity.orgId);
      if (before === undefined) throw new ApiError("not_found");
      const changes = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      const row = await this.repository.update(tx, identity.orgId, {
        ...changes,
        updatedAt: this.now(),
      });
      if (row === undefined) throw new ApiError("not_found");
      const fields = Object.keys(changes) as (keyof OrganizationRow)[];
      await this.audit.record(tx, {
        action: `${ORGANIZATION_SUBJECT}.update`,
        entityType: ORGANIZATION_SUBJECT,
        entityId: identity.orgId,
        before: Object.fromEntries(fields.map((f) => [f, before[f]])),
        after: Object.fromEntries(fields.map((f) => [f, row[f]])),
      });
      return toData(row);
    });
  }

  async archiveCurrent(): Promise<OrganizationData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const now = this.now();
      const row = await this.repository.update(tx, identity.orgId, {
        updatedAt: now,
        archivedAt: now,
      });
      if (row === undefined) throw new ApiError("not_found");
      // P6-06 (ADR 0077, D14): every pending invitation of the org dies
      // with it, in this transaction, one org.invitation.revoke each.
      const revoked = await this.revokeInvitations(tx, {
        orgId: identity.orgId,
        scope: { allInOrg: true },
        reason: "org_archived",
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
      await this.audit.record(tx, {
        action: `${ORGANIZATION_SUBJECT}.archive`,
        entityType: ORGANIZATION_SUBJECT,
        entityId: identity.orgId,
        after: { archivedAt: row.archivedAt },
      });
      return toData(row);
    });
  }

  /** The committed organisation `orgId`, read as the signed-in user. */
  private async readAs(orgId: string): Promise<OrganizationData> {
    const row = await this.runner.runSignedIn(orgId, (tx) =>
      readOrganization(tx, orgId),
    );
    if (row === undefined) throw new ApiError("not_found");
    return toData(row);
  }

  /** The country's measurement system (CLDR, @bricx/domain; D8). */
  private unitsOf(country: string): "metric" | "us_customary" {
    const result = unitSystemFor(country);
    if (!result.ok) throw new Error("no unit system for a valid country");
    return result.value;
  }

  private origin() {
    const context = currentRequestContext();
    return context === undefined
      ? { correlationId: this.ids.next() }
      : {
          correlationId: context.correlationId,
          ip: context.ip,
          deviceId: context.deviceId,
          geo: context.geo,
        };
  }
}

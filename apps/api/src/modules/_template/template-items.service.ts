// TemplateItems' service (P4-09, ADR 0059). Each call: the identity (none
// before P5: NoTenantContextError, 401 session_expired), the policy check
// (403) before any database work, then one TxRunner transaction. A create
// writes the row, its outbox event and its audit event in that one
// transaction (CLAUDE.md rules 2 and 5); the audit event is the last
// statement (ADR 0055: record() holds the org's chain lock until COMMIT).
import { Inject, Injectable } from "@nestjs/common";
import {
  NoTenantContextError,
  currentRequestContext,
} from "../../common/db/request-context.js";
import type { Identity } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import {
  type TemplateItemData,
  decodeCursor,
  encodeCursor,
} from "./template-items.dto.js";
import {
  TEMPLATE_ITEMS_CREATED,
  createdPayload,
} from "./template-items.events.js";
import {
  SUBJECT,
  assertCanCreate,
  canRead,
  readFilters,
} from "./template-items.policies.js";
import { TemplateItemsRepository } from "./template-items.repository.js";

export interface CreateTemplateItemInput {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}

export interface ListTemplateItemsInput {
  readonly projectId: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface TemplateItemPageData {
  readonly items: TemplateItemData[];
  readonly nextCursor: string | null;
}

function requireIdentity(): Identity {
  const identity = currentRequestContext()?.identity;
  if (identity === undefined) throw new NoTenantContextError();
  return identity;
}

@Injectable()
export class TemplateItemsService {
  constructor(
    @Inject(TxRunner) private readonly runner: TxRunner,
    @Inject(TemplateItemsRepository)
    private readonly repository: TemplateItemsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  create(input: CreateTemplateItemInput): Promise<TemplateItemData> {
    const identity = requireIdentity();
    const record = {
      orgId: identity.orgId,
      projectId: input.projectId,
      createdBy: identity.userId,
    };
    assertCanCreate(identity, record);
    return this.runner.run(async (tx) => {
      const item = await this.repository.insert(tx, {
        ...record,
        id: input.id,
        name: input.name,
      });
      await this.outbox.enqueue(
        tx,
        TEMPLATE_ITEMS_CREATED,
        createdPayload(item),
      );
      await this.audit.record(tx, {
        action: `${SUBJECT}.create`,
        entityType: SUBJECT,
        entityId: item.id,
        after: { projectId: item.projectId, name: item.name },
      });
      return item;
    });
  }

  /** One item; not_found (404) when RLS hides it or it may not be read. */
  async get(id: string): Promise<TemplateItemData> {
    const identity = requireIdentity();
    const item = await this.runner.run((tx) =>
      this.repository.findById(tx, id),
    );
    if (
      item === undefined ||
      !canRead(identity, {
        orgId: identity.orgId,
        projectId: item.projectId,
        createdBy: item.createdBy,
      })
    ) {
      throw new ApiError("not_found");
    }
    return item;
  }

  /** One page of a project's items, by id. */
  async list(input: ListTemplateItemsInput): Promise<TemplateItemPageData> {
    const identity = requireIdentity();
    const filters = readFilters(identity);
    const after =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rows = await this.runner.run((tx) =>
      this.repository.list(tx, {
        projectId: input.projectId,
        filters,
        after,
        limit: input.limit + 1,
      }),
    );
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? encodeCursor(last.id)
          : null,
    };
  }
}

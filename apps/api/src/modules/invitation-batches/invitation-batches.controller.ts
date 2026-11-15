// Bulk invitations' routes (P6-06c, ADR 0085), under
// /v1/invitation-batches, in the invitation rate-limit class:
//   POST /           @Idempotent() submit (202 {batchId, accepted, failed})  (org.member.invite.org)
//   GET  /:id        the batch and its counts                               (org.member.read.org)
//   GET  /:id/rows   per-row results by rowNo, ?cursor&limit≤100            (org.member.read.org)
// A project row also needs project.member.assign there: the service's
// row check (escalation), as for a single invite. The handlers only parse
// and delegate.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Can } from "../../common/auth/can.decorator.js";
import { Idempotent } from "../../common/idempotency/decorator.js";
import { RateLimit } from "../../common/rate-limit/rate-limit.decorator.js";
import {
  BatchAccepted,
  BatchParams,
  BatchRowsQuery,
  InvitationBatch,
  InvitationBatchRowList,
  SubmitBatch,
} from "./invitation-batches.dto.js";
import {
  InvitationBatchesService,
  type InvitationBatchesPort,
} from "./invitation-batches.service.js";

@Controller({ path: "invitation-batches", version: "1" })
@RateLimit("invitation")
export class InvitationBatchesController {
  constructor(
    @Inject(InvitationBatchesService)
    private readonly service: InvitationBatchesPort,
  ) {}

  @Post()
  @Can("org.member.invite")
  @Idempotent()
  @HttpCode(202)
  @ZodResponse({ status: 202, type: BatchAccepted })
  submit(@Body() body: SubmitBatch) {
    return this.service.submit(body);
  }

  @Get(":id")
  @Can("org.member.read")
  @ZodResponse({ status: 200, type: InvitationBatch })
  get(@Param() params: BatchParams) {
    return this.service.get(params.id);
  }

  @Get(":id/rows")
  @Can("org.member.read")
  @ZodResponse({ status: 200, type: InvitationBatchRowList })
  rows(@Param() params: BatchParams, @Query() query: BatchRowsQuery) {
    return this.service.rows(params.id, query);
  }
}

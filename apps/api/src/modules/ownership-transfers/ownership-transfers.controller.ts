// Ownership transfers' routes (P6-06c, ADR 0085), under
// /v1/organizations/current/ownership-transfers, every one in the
// auth_adjacent rate-limit class (owner answer Q5). The checks are the
// service's (@NoPermission: the owner is read by system_key, never by a
// key a custom role could hold; owner condition C4):
//   POST /             @FreshAuth() @Idempotent() start (201)  (an active owner)
//   GET  /pending      the org's pending transfer              (an active owner or the recipient)
//   POST /:id/accept   @FreshAuth() @Idempotent() (200)        (the recipient; the initiator is 403, Q1)
//   POST /:id/decline  @Idempotent() (200)                     (the recipient)
//   POST /:id/cancel   @Idempotent() (200)                     (an active owner, acr mfa)
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { NoPermission } from "../../common/auth/can.decorator.js";
import { FreshAuth } from "../../common/auth/fresh-auth.js";
import { Idempotent } from "../../common/idempotency/decorator.js";
import { RateLimit } from "../../common/rate-limit/rate-limit.decorator.js";
import {
  OwnershipTransfer,
  StartTransfer,
  TransferName,
  TransferParams,
} from "./ownership-transfers.dto.js";
import {
  OwnershipTransfersService,
  type OwnershipTransfersPort,
} from "./ownership-transfers.service.js";

@Controller({
  path: "organizations/current/ownership-transfers",
  version: "1",
})
@RateLimit("auth_adjacent")
export class OwnershipTransfersController {
  constructor(
    @Inject(OwnershipTransfersService)
    private readonly service: OwnershipTransfersPort,
  ) {}

  @Post()
  @NoPermission("an active owner by system_key; the service checks it")
  @FreshAuth()
  @Idempotent()
  @ZodResponse({ status: 201, type: OwnershipTransfer })
  start(@Body() body: StartTransfer) {
    return this.service.start(body);
  }

  @Get("pending")
  @NoPermission("an active owner or the recipient; the service checks it")
  @ZodResponse({ status: 200, type: OwnershipTransfer })
  pending() {
    return this.service.pending();
  }

  @Post(":id/accept")
  @NoPermission("the recipient only; the service checks it")
  @FreshAuth()
  @Idempotent()
  @HttpCode(200)
  @ZodResponse({ status: 200, type: OwnershipTransfer })
  accept(@Param() params: TransferParams, @Body() body: TransferName) {
    return this.service.accept(params.id, body);
  }

  @Post(":id/decline")
  @NoPermission("the recipient only; the service checks it")
  @Idempotent()
  @HttpCode(200)
  @ZodResponse({ status: 200, type: OwnershipTransfer })
  decline(@Param() params: TransferParams) {
    return this.service.decline(params.id);
  }

  @Post(":id/cancel")
  @NoPermission("an active owner at acr mfa; the service checks it")
  @Idempotent()
  @HttpCode(200)
  @ZodResponse({ status: 200, type: OwnershipTransfer })
  cancel(@Param() params: TransferParams) {
    return this.service.cancel(params.id);
  }
}

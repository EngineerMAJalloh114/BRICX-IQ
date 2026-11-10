// Invitations' routes (P6-06, ADR 0077), under /v1/invitations, every one
// in the invitation rate-limit class (D16):
//   POST   /                 @Idempotent() create (201)   (org.member.invite.org; a project one also project.member.assign)
//   GET    /                 newest first, ?status&projectId&cursor&limit≤100 (org.member.read.org)
//   GET    /:id              one invitation                (org.member.read.org)
//   POST   /:id/resend       @Idempotent() a new send      (org.member.invite.org)
//   DELETE /:id              revoke (204, idempotent)      (org.member.invite.org)
//   POST   /activate         @Public(): {token} → always 202 (D6, D8); the ip limit, fails closed
//   POST   /accept           @SignedIn(): {token} → 200 or the uniform 404 (D7, D8)
// The token travels only in a POST body (D2), never in a path or query.
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Can } from "../../common/auth/can.decorator.js";
import { Public } from "../../common/auth/public.decorator.js";
import { SignedIn } from "../../common/auth/signed-in.decorator.js";
import { AuthFailure, bearerToken } from "../../common/auth/token-verifier.js";
import { ApiError } from "../../common/errors/api-error.js";
import { Idempotent } from "../../common/idempotency/decorator.js";
import { RateLimit } from "../../common/rate-limit/rate-limit.decorator.js";
import {
  AcceptedInvitation,
  ActivationAccepted,
  CreateInvitation,
  Invitation,
  InvitationList,
  InvitationParams,
  InvitationToken,
  ListInvitationsQuery,
} from "./invitations.dto.js";
import {
  InvitationsService,
  type InvitationsPort,
} from "./invitations.service.js";

@Controller({ path: "invitations", version: "1" })
@RateLimit("invitation")
export class InvitationsController {
  constructor(
    @Inject(InvitationsService) private readonly service: InvitationsPort,
  ) {}

  @Post()
  @Can("org.member.invite")
  @Idempotent()
  @ZodResponse({ status: 201, type: Invitation })
  create(@Body() body: CreateInvitation) {
    return this.service.create(body);
  }

  @Get()
  @Can("org.member.read")
  @ZodResponse({ status: 200, type: InvitationList })
  list(@Query() query: ListInvitationsQuery) {
    return this.service.list(query);
  }

  // Before ":id" so Nest never reads "activate" or "accept" as an id
  // (both are POST, and ":id" has no POST; kept first for clarity).
  @Post("activate")
  @Public()
  @HttpCode(202)
  @ZodResponse({ status: 202, type: ActivationAccepted })
  activate(@Body() body: InvitationToken) {
    return this.service.activate(body.token);
  }

  @Post("accept")
  @SignedIn()
  @HttpCode(200)
  @ZodResponse({ status: 200, type: AcceptedInvitation })
  accept(
    @Body() body: InvitationToken,
    @Headers("authorization") authorization: string | undefined,
  ) {
    let bearer: string;
    try {
      bearer = bearerToken(authorization);
    } catch (error) {
      // The AuthGuard verified this very header; a failure here is not expected.
      if (error instanceof AuthFailure) throw new ApiError("unauthenticated");
      throw error;
    }
    return this.service.accept(body.token, bearer);
  }

  @Get(":id")
  @Can("org.member.read")
  @ZodResponse({ status: 200, type: Invitation })
  get(@Param() params: InvitationParams) {
    return this.service.get(params.id);
  }

  @Post(":id/resend")
  @Can("org.member.invite")
  @Idempotent()
  @HttpCode(200)
  @ZodResponse({ status: 200, type: Invitation })
  resend(@Param() params: InvitationParams) {
    return this.service.resend(params.id);
  }

  @Delete(":id")
  @Can("org.member.invite")
  @HttpCode(204)
  revoke(@Param() params: InvitationParams) {
    return this.service.revoke(params.id);
  }
}

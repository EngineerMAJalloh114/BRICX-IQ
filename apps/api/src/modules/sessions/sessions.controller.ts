// Sessions' routes (P5-03, ADR 0063):
//   GET    /v1/sessions                     the caller's sessions, every org
//   DELETE /v1/sessions/:id                 close one of the caller's (204)
//   GET    /v1/users/:userId/sessions       a user's sessions in this org
//                                           (org.session.read.org)
//   POST   /v1/users/:userId/sessions/revoke close a user's open sessions in
//                                           this org (org.session.revoke.org)
// The handlers only parse and delegate.
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Can, NoPermission } from "../../common/auth/can.decorator.js";
import {
  RevokedSessions,
  SessionList,
  SessionParams,
  UserSessionsParams,
} from "./sessions.dto.js";
import { SessionsService, type SessionsPort } from "./sessions.service.js";

@Controller({ path: "sessions", version: "1" })
export class SessionsController {
  constructor(
    @Inject(SessionsService) private readonly service: SessionsPort,
  ) {}

  @Get()
  @NoPermission("the caller's own sessions; RLS own-row read")
  @ZodResponse({ status: 200, type: SessionList })
  async list() {
    return { items: await this.service.listMine() };
  }

  @Delete(":id")
  @NoPermission("closes one of the caller's own sessions; RLS own-row write")
  @HttpCode(204)
  revoke(@Param() params: SessionParams) {
    return this.service.revokeMine(params.id);
  }
}

@Controller({ path: "users/:userId/sessions", version: "1" })
export class UserSessionsController {
  constructor(
    @Inject(SessionsService) private readonly service: SessionsPort,
  ) {}

  @Get()
  @Can("org.session.read")
  @ZodResponse({ status: 200, type: SessionList })
  async list(@Param() params: UserSessionsParams) {
    return { items: await this.service.listOfUser(params.userId) };
  }

  @Post("revoke")
  @Can("org.session.revoke")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: RevokedSessions })
  async revoke(@Param() params: UserSessionsParams) {
    return { revoked: await this.service.revokeOfUser(params.userId) };
  }
}

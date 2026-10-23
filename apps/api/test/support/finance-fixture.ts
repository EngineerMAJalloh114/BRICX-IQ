// The test-only finance routes (P5-07, ADR 0068; owner decision D-D and
// condition 5). They exist only in test/support and reach an app only
// through createApp's test option extraControllers: src has no finance
// route before P9, and src never imports this folder (Semgrep
// bricx-src-imports-test-support). Each route is a @Can() declaration and
// a handler that answers what it was given, so a suite sees exactly what
// the guard let through:
// - POST /v1/test-finance/projects/:projectId/payments/:paymentId/approve
//   finance.payment.approve at the project in the path (step-up: finance);
// - POST /v1/test-finance/projects/:projectId/payments
//   finance.payment.request at the project in the path (finance);
// - GET  /v1/test-finance/projects/:projectId/milestones
//   project.milestone.read at the project in the path (not finance);
// - GET  /v1/test-finance/milestones  project.milestone.read anywhere in
//   the org (no scope parameter declared);
// - GET  /v1/test-finance/roles       org.role.read (an org resource).
import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Can } from "../../src/common/auth/can.decorator.js";
import { currentRequestContext } from "../../src/common/db/request-context.js";

/** The route prefix (URI versioning adds /v1). */
export const FINANCE_FIXTURE_PATH = "test-finance";

const who = () => {
  const identity = currentRequestContext()?.identity;
  return {
    userId: identity?.userId ?? null,
    acr: identity?.acr ?? null,
  };
};

@Controller({ path: FINANCE_FIXTURE_PATH, version: "1" })
export class FinanceFixtureController {
  @Post("projects/:projectId/payments/:paymentId/approve")
  @HttpCode(200)
  @Can("finance.payment.approve", { projectParam: "projectId" })
  approve(
    @Param("projectId") projectId: string,
    @Param("paymentId") paymentId: string,
  ) {
    return { approved: true, projectId, paymentId, ...who() };
  }

  @Post("projects/:projectId/payments")
  @HttpCode(200)
  @Can("finance.payment.request", { projectParam: "projectId" })
  request(@Param("projectId") projectId: string) {
    return { requested: true, projectId, ...who() };
  }

  @Get("projects/:projectId/milestones")
  @Can("project.milestone.read", { projectParam: "projectId" })
  milestones(@Param("projectId") projectId: string) {
    return { read: true, projectId, ...who() };
  }

  @Get("milestones")
  @Can("project.milestone.read")
  anywhere() {
    return { read: true, ...who() };
  }

  @Get("roles")
  @Can("org.role.read")
  roles() {
    return { read: true, ...who() };
  }
}

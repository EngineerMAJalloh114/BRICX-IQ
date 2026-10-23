// The test-only SoD routes (P5-07, ADR 0068; owner decision D-D and
// condition 5, Done when DW5-DW7). Like finance-fixture.ts they live only
// in test/support and reach an app only through createApp's test option
// extraControllers. Each runs SodService in one TxRunner transaction, the
// way a finance module will (P9): the check and the history row are in the
// action's transaction.
// - POST /v1/test-sod/projects/:projectId/payments/:paymentId/request
//   @Can finance.payment.request: performs "request" on the payment's
//   chain, answers the derived approval state;
// - POST /v1/test-sod/projects/:projectId/payments/:paymentId/approve
//   @Can finance.payment.approve (step-up): performs "approve";
// - GET  /v1/test-sod/projects/:projectId/payments/:paymentId
//   @Can finance.payment.read: the derived approval state (D-B);
// - POST /v1/test-sod/chains/:chainId/actions  {recordType, action,
//   projectId?, fail?}: performs any catalogue action on a chain (DW5:
//   every SOD_RULES pair); fail rolls the transaction back after the
//   action (DW5: nothing recorded). @NoPermission: a probe of the service,
//   not of the guard.
import { isProjectId } from "@bricx/ids/branded";
import { isUuidV7 } from "@bricx/ids/uuid-v7";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { Can, NoPermission } from "../../src/common/auth/can.decorator.js";
import { TxRunner } from "../../src/common/db/tx-runner.js";
import { ApiError } from "../../src/common/errors/api-error.js";
import { SodService } from "../../src/modules/sod/public-api.js";

const PAYMENT = "finance.payment";
const P = { projectParam: "projectId" } as const;

/** Thrown inside the transaction by fail: true (500, rolled back). */
class RollbackProbe extends Error {}

const paymentOf = (projectId: string, paymentId: string) => {
  if (!isProjectId(projectId) || !isUuidV7(paymentId)) {
    throw new ApiError("not_found");
  }
  return { chainId: paymentId, recordId: paymentId, projectId };
};

@Controller({ path: "test-sod", version: "1" })
export class SodFixtureController {
  constructor(
    @Inject(TxRunner) private readonly runner: TxRunner,
    @Inject(SodService) private readonly sod: SodService,
  ) {}

  @Post("projects/:projectId/payments/:paymentId/request")
  @HttpCode(200)
  @Can("finance.payment.request", P)
  request(
    @Param("projectId") projectId: string,
    @Param("paymentId") paymentId: string,
  ) {
    const payment = paymentOf(projectId, paymentId);
    return this.runner.run(async (tx) => {
      await this.sod.perform(tx, {
        ...payment,
        recordType: PAYMENT,
        action: "request",
      });
      return {
        state: await this.sod.approvalState(tx, {
          ...payment,
          recordType: PAYMENT,
        }),
      };
    });
  }

  @Post("projects/:projectId/payments/:paymentId/approve")
  @HttpCode(200)
  @Can("finance.payment.approve", P)
  approve(
    @Param("projectId") projectId: string,
    @Param("paymentId") paymentId: string,
  ) {
    const payment = paymentOf(projectId, paymentId);
    return this.runner.run(async (tx) => {
      await this.sod.perform(tx, {
        ...payment,
        recordType: PAYMENT,
        action: "approve",
      });
      return { approved: true };
    });
  }

  @Get("projects/:projectId/payments/:paymentId")
  @Can("finance.payment.read", P)
  state(
    @Param("projectId") projectId: string,
    @Param("paymentId") paymentId: string,
  ) {
    const payment = paymentOf(projectId, paymentId);
    return this.runner.run(async (tx) => ({
      state: await this.sod.approvalState(tx, {
        ...payment,
        recordType: PAYMENT,
      }),
    }));
  }

  @Post("chains/:chainId/actions")
  @HttpCode(200)
  @NoPermission("test-only probe of the SoD service (DW5)")
  act(@Param("chainId") chainId: string, @Body() body: unknown) {
    const field = (name: string): unknown =>
      typeof body === "object" && body !== null
        ? Reflect.get(body, name)
        : undefined;
    const recordType = field("recordType");
    const action = field("action");
    const rawProject = field("projectId");
    const projectId =
      rawProject === undefined
        ? null
        : isProjectId(rawProject)
          ? rawProject
          : undefined;
    if (
      !isUuidV7(chainId) ||
      typeof recordType !== "string" ||
      typeof action !== "string" ||
      projectId === undefined
    ) {
      throw new ApiError("not_found");
    }
    return this.runner.run(async (tx) => {
      await this.sod.perform(tx, {
        chainId,
        recordId: chainId,
        recordType,
        action,
        projectId,
      });
      if (field("fail") === true) throw new RollbackProbe();
      return { done: true };
    });
  }
}

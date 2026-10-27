// The global exception filter (P4-07, ADR 0057, decisions 2a and 3a):
// every error leaves as an application/problem+json body in the ADR 0047
// envelope, traceId = the correlation id (x-request-id). 5xx are logged
// at error with the error (stack included) as `request.failed`; 4xx at
// info as `request.rejected`, with the code and status only. Nothing from
// the error reaches the body. The health routes keep terminus's body
// (health.filter.ts). P5-02 (ADR 0062, owner condition 4): a 401
// `unauthenticated` also carries WWW-Authenticate: Bearer (RFC 6750),
// the same for every reason. P5-07 (ADR 0068): 401
// permission.step_up_required carries the RFC 9470 challenge instead.
import { TransactionCommitError, sqlstateOf } from "@bricx/db/database";
import { ERROR_STATUS } from "@bricx/validation/codes";
import {
  type ErrorEnvelope,
  TraceIdSchema,
  errorEnvelope,
} from "@bricx/validation/error-envelope";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from "@nestjs/common";
import { ZodSerializationException } from "nestjs-zod";
import { ZodError } from "zod";
import { problemFor } from "./problem.js";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
/**
 * The RFC 9470 step-up challenge (P5-07, ADR 0068, owner decision D-F as
 * changed): a finance key at an authentication level below mfa.
 */
export const STEP_UP_CHALLENGE =
  'Bearer error="insufficient_user_authentication", acr_values="mfa"';

interface SerializationFields {
  readonly issues?: readonly { path: PropertyKey[]; code: string }[];
  readonly error?: string;
}

function serializationFields(
  exception: unknown,
): SerializationFields | undefined {
  if (!(exception instanceof ZodSerializationException)) return undefined;
  const cause: unknown = exception.getZodError();
  if (cause instanceof ZodError) {
    return {
      issues: cause.issues.map((issue) => ({
        path: [...issue.path],
        code: issue.code,
      })),
    };
  }
  return { error: cause instanceof Error ? cause.name : typeof cause };
}

interface ProblemRequest {
  readonly id: string;
  readonly log: {
    info(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

interface ProblemReply {
  status(code: number): ProblemReply;
  header(name: string, value: string): ProblemReply;
  send(payload: string): unknown;
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ProblemRequest>();
    const reply = http.getResponse<ProblemReply>();
    const problem = problemFor(exception);
    const status = ERROR_STATUS[problem.code];
    const traceId = TraceIdSchema.safeParse(request.id);
    const envelope: ErrorEnvelope = {
      ...errorEnvelope(
        problem.code,
        traceId.success ? { traceId: traceId.data } : {},
      ),
      ...(problem.issues === undefined ? {} : { issues: problem.issues }),
      ...(problem.truncated === undefined ? {} : { truncated: true }),
    };
    // The SQLSTATE, when a database error is behind the answer: from the
    // commit error, or from the driver's error (through Drizzle's wrapper).
    const sqlstate =
      exception instanceof TransactionCommitError
        ? exception.sqlstate
        : sqlstateOf(exception);
    // A response the serializer refused (P4-08, ADR 0058): the issue
    // paths and codes are logged (never the value), nothing is sent.
    const serialization = serializationFields(exception);
    const fields = {
      code: problem.code,
      status,
      ...(sqlstate === undefined ? {} : { sqlstate }),
      ...(serialization === undefined ? {} : { serialization }),
    };
    if (problem.log === "error") {
      request.log.error({ ...fields, err: exception }, "request.failed");
    } else {
      request.log.info(fields, "request.rejected");
    }
    // RFC 6750: every 401 of the bearer scheme names it (P5-03 adds
    // session_expired, which the guard answers for a revoked or idle
    // session; for architect review).
    if (
      problem.code === "unauthenticated" ||
      problem.code === "session_expired"
    ) {
      void reply.header("www-authenticate", "Bearer");
    }
    if (problem.code === "permission.step_up_required") {
      void reply.header("www-authenticate", STEP_UP_CHALLENGE);
    }
    void reply
      .status(status)
      .header("content-type", PROBLEM_CONTENT_TYPE)
      .send(JSON.stringify(envelope));
  }
}

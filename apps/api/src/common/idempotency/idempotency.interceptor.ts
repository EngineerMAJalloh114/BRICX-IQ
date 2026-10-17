// The idempotency interceptor (P4-07, ADR 0057, decision 6a). Global,
// after RequestContextInterceptor. On an @Idempotent() route it validates
// the Idempotency-Key header before anything touches the database (400
// idempotency.key_missing / key_invalid), computes the fingerprint and the
// declared status, and stashes the state for TxRunner.run(). After the
// handler it sends the stored text verbatim, first answer and replay
// alike (owner condition 1): the same bytes, the allow-listed headers,
// the replay request's own x-request-id, and Idempotent-Replayed: true on
// a replay only. A handler that never opened run() is a misuse (500).
import { IDEMPOTENCY_KEY_PATTERN } from "@bricx/db/idempotency";
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type Observable, map } from "rxjs";
import { setRequestSlot } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_METADATA,
  REPLAYED_HEADER,
} from "./decorator.js";
import { idempotencyRoute, requestFingerprint } from "./fingerprint.js";
import {
  IDEMPOTENCY_SLOT,
  type IdempotencyState,
  IdempotencyMisuseError,
} from "./state.js";

/**
 * @nestjs/common/constants' HTTP_CODE_METADATA (not in its exports map):
 * the status @HttpCode() declares. Proved by the ETag replay with
 * @HttpCode(200) in test/idempotency.int.test.ts.
 */
const HTTP_CODE_METADATA = "__httpCode__";

const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;.*)?$/i;

const isJson = (contentType: string | string[] | undefined): boolean =>
  typeof contentType === "string" && JSON_MEDIA_TYPE.test(contentType);

interface IdempotentRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly query: unknown;
  readonly body: unknown;
}

interface IdempotentReply {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      context.getType() !== "http" ||
      this.reflector.get<boolean | undefined>(
        IDEMPOTENT_METADATA,
        context.getHandler(),
      ) !== true
    ) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const reply = http.getResponse<IdempotentReply>();
    // A body that is not JSON cannot be fingerprinted (owner condition 6).
    if (
      request.body !== undefined &&
      !isJson(request.headers["content-type"])
    ) {
      throw new ApiError("request.unsupported_media_type");
    }
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (header === undefined) throw new ApiError("idempotency.key_missing");
    if (typeof header !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
      throw new ApiError("idempotency.key_invalid");
    }
    const declared: unknown = this.reflector.get(
      HTTP_CODE_METADATA,
      context.getHandler(),
    );
    const state: IdempotencyState = {
      key: header,
      route: idempotencyRoute(request.method, request.url),
      requestHash: requestFingerprint({
        query: request.query,
        body: request.body,
      }),
      status:
        typeof declared === "number"
          ? declared
          : request.method.toUpperCase() === "POST"
            ? 201
            : 200,
      replyHeader: (name) => {
        const value = reply.getHeader(name);
        return typeof value === "string" ? value : undefined;
      },
      runs: 0,
      response: undefined,
      replayed: false,
    };
    setRequestSlot(IDEMPOTENCY_SLOT, state);
    return next.handle().pipe(
      map(() => {
        const { response } = state;
        if (state.runs === 0 || response === undefined) {
          throw new IdempotencyMisuseError("no_run");
        }
        reply.status(response.status);
        for (const [name, value] of Object.entries(response.headers)) {
          reply.header(name, value);
        }
        if (state.replayed) reply.header(REPLAYED_HEADER, "true");
        // A string with a JSON content-type: Fastify sends it as is.
        return response.body;
      }),
    );
  }
}

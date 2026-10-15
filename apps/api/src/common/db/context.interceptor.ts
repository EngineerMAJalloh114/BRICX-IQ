// Seals the request context before the handler (P4-03, ADR 0053; owner
// change 1): guards have run, so the identity, if any, is final. The
// interceptor only reads and validates: an invalid identity fails the
// request (500, no detail) before the handler, and the frozen context is
// what the handler, TxRunner and later the audit log read.
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { sealRequestContext } from "./request-context.js";

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === "http") sealRequestContext();
    return next.handle();
  }
}

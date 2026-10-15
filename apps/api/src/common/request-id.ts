// The correlation id (x-request-id): a client's id is kept when it is
// 1-128 characters of [A-Za-z0-9._-] (safe in headers and log lines);
// otherwise, or when absent, a new UUIDv7 replaces it.
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import type { Clock } from "./clock.js";

export const REQUEST_ID_HEADER = "x-request-id";
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestIdGenerator(
  clock: Clock,
): (header: string | string[] | undefined) => string {
  const ids = createUuidV7Generator({ clock });
  return (header) =>
    typeof header === "string" && SAFE_ID.test(header) ? header : ids.next();
}

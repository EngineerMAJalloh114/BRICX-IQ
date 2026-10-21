// @RegistersDevice() (P5-03, ADR 0063, owner condition 4): the one route
// (POST /v1/devices) on which the AuthGuard accepts an X-Device-Id that
// names no registered device, because the request registers it. The
// guard then tracks the session without a device; the handler checks
// that the header and the body carry the same id and binds the session.
// Handler-level only (never a class), and an OpenAPI extension, so
// test/auth-routes.test.ts pins the set of such operations.
import { SetMetadata, applyDecorators } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";

/** The metadata key AuthGuard reads (the handler only). */
export const REGISTERS_DEVICE = "bricx:registers-device";
/** The OpenAPI extension on such an operation. */
export const REGISTERS_DEVICE_EXTENSION = "x-bricx-registers-device";

export const RegistersDevice = () =>
  applyDecorators(
    SetMetadata(REGISTERS_DEVICE, true),
    ApiExtension(REGISTERS_DEVICE_EXTENSION, true),
  );

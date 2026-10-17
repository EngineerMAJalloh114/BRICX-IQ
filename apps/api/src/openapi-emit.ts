// Entry of `pnpm --filter @bricx/api openapi:emit` (P4-08, ADR 0058):
// writes packages/api-client/openapi.json. Run through dist/register.js
// like the other entries (see package.json).
import { writeFileSync } from "node:fs";
import { OPENAPI_OUTPUT_PATH, emitOpenApiDocument } from "./openapi/emit.js";

const text = await emitOpenApiDocument();
writeFileSync(OPENAPI_OUTPUT_PATH, text);
process.stdout.write(`${OPENAPI_OUTPUT_PATH}: ${String(text.length)} bytes\n`);

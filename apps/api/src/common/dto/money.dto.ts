// The Money DTO (P4-08, ADR 0058, decision 5a): nestjs-zod's codec DTO
// over @bricx/money's MoneySchema. As a @Body() type the global
// ZodValidationPipe decodes the wire form { amount: "<minor units>",
// currency } to a Money (bigint minor units); as a @ZodResponse() type the
// serializer encodes a Money back to the wire form, so a bigint never
// reaches JSON.stringify. The class is named Money so the document's
// component is `Money` (owner condition 2: amount is a string with
// pattern ^-?\d+$, added by the document post-processing).
import { MoneySchema } from "@bricx/money/schema";
import { createZodDto } from "nestjs-zod";

export class Money extends createZodDto(MoneySchema, { codec: true }) {}

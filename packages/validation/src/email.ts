// EmailSchema (P3-04 D5, ruling 5): zod's default email pattern (ASCII), at
// most 254 characters with a local part of at most 64, checked before the
// pattern. No trimming: any whitespace is rejected. The output is
// lowercased in full to match Keycloak's normalisation of email addresses;
// that is a Keycloak match, not an RFC 5321 guarantee (the RFC leaves the
// local part case-sensitive).
import type { z } from "zod";
import { boundedString, issueMessage } from "./bounded.ts";
import { FORMATS } from "./formats.ts";
import { LIMITS } from "./limits.ts";

export const EMAIL_MAX = LIMITS.email;
export const EMAIL_LOCAL_MAX = LIMITS.emailLocal;

export const EmailSchema = boundedString(
  FORMATS.email,
  issueMessage("invalid_email"),
)
  .toLowerCase()
  .brand<"Email">();

export type Email = z.output<typeof EmailSchema>;

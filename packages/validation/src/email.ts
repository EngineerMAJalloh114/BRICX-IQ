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

/** Most UTF-16 code units read before normalising (bounds the work first). */
const NORMALISE_INPUT_MAX = 1024;

/**
 * The one e-mail normaliser of invitations (P6-06, ADR 0077; owner
 * condition C3: the invite and the accept use the same one): Unicode
 * NFKC, then trimmed, then EmailSchema (the shape, its bounds, lowercased
 * in full). undefined for anything that is not an address afterwards.
 */
export function normaliseEmail(raw: unknown): Email | undefined {
  if (typeof raw !== "string" || raw.length > NORMALISE_INPUT_MAX) {
    return undefined;
  }
  const parsed = EmailSchema.safeParse(raw.normalize("NFKC").trim());
  return parsed.success ? parsed.data : undefined;
}

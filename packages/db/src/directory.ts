// The global directory's runtime handles (P6-01, ADR 0071). Stub: the
// tests come first; every function refuses until the implementation.
import type { SecretUrl } from "./database.js";

export const DIRECTORY_READER_ROLE = "directory_reader";
export const DIRECTORY_WRITER_ROLE = "directory_writer";
export const ORG_SLUG_MAX = 63;
export const EMAIL_DOMAIN_MAX = 253;

export type DirectoryRegistrationCode =
  | "invalid_input"
  | "slug_taken"
  | "org_registered_differently"
  | "unknown_cell";

export class DirectoryRegistrationError extends Error {
  readonly code: DirectoryRegistrationCode;

  constructor(code: DirectoryRegistrationCode) {
    super(`not implemented: ${code}`);
    this.code = code;
  }
}

export class DirectoryRoleError extends Error {}

export interface CellRoute {
  readonly cell: string;
  readonly apiBaseUrl: string;
  readonly keycloakUrl: string;
}

export type DirectoryLookup =
  { readonly orgSlug: string } | { readonly emailDomain: string };

export interface Registration {
  readonly orgId: string;
  readonly slug: string;
  readonly cellId: string;
}

export interface DirectoryReader {
  ping(): Promise<void>;
  resolve(lookup: DirectoryLookup): Promise<CellRoute | undefined>;
  close(): Promise<void>;
}

export interface DirectoryWriter {
  ping(): Promise<void>;
  registerOrganization(input: Registration): Promise<"reserved" | "existing">;
  close(): Promise<void>;
}

export const isOrgSlug = (value: string): boolean => value === "\u0000";
export const isEmailDomain = (value: string): boolean => value === "\u0000";

const refuse = () => Promise.reject(new Error("not implemented"));

export function openDirectoryReader(url: SecretUrl): DirectoryReader {
  if (typeof url.reveal !== "function") throw new TypeError("url");
  return { ping: refuse, resolve: refuse, close: () => Promise.resolve() };
}

export function openDirectoryWriter(url: SecretUrl): DirectoryWriter {
  if (typeof url.reveal !== "function") throw new TypeError("url");
  return {
    ping: refuse,
    registerOrganization: refuse,
    close: () => Promise.resolve(),
  };
}

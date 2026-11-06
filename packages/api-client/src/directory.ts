// Stub (P6-01): the tests come first.
export interface CellRoute {
  readonly cell: string;
  readonly apiBaseUrl: string;
  readonly keycloakUrl: string;
}

export type CellLookup = { readonly email: string } | { readonly slug: string };

export interface ResolveCellOptions {
  readonly directoryUrl: string;
  readonly fetch?: typeof fetch;
  readonly production?: boolean;
}

export type DirectoryClientCode =
  "invalid_lookup" | "insecure_url" | "invalid_response";

export class CellNotFoundError extends Error {}
export class DirectoryClientError extends Error {
  readonly code: DirectoryClientCode;
  constructor(code: DirectoryClientCode) {
    super(code);
    this.code = code;
  }
}

export function resolveCell(
  lookup: CellLookup,
  options: ResolveCellOptions,
): Promise<CellRoute> {
  return Promise.reject(
    new Error(
      `resolveCell: not implemented (${typeof lookup}, ${typeof options})`,
    ),
  );
}

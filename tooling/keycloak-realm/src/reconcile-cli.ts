// The `pnpm keycloak:reconcile` command (P6-05e, ADR 0081, condition C5):
// brings the running realm named by KEYCLOAK_ISSUER to the realm file's
// managed settings (src/reconcile.ts), signing in as the local bootstrap
// admin (KEYCLOAK_ADMIN_USERNAME / KEYCLOAK_ADMIN_PASSWORD from .env).
// Flags: --check (report drift, change nothing, exit 1 on drift),
// --allow-remote (a non-local Keycloak; P13-01's deploy step). Exit codes:
// 0 in sync or applied, 1 drift found by --check, 2 refused or failed.
// Prints field names only; an error prints its code, never a value.
import process from "node:process";
import { loadRealm } from "./realm.js";
import {
  ReconcileError,
  desiredSettings,
  passwordToken,
  realmAdmin,
  reconcile,
  report,
  targetOf,
} from "./reconcile.js";

const KNOWN_FLAGS: ReadonlySet<string> = new Set(["--check", "--allow-remote"]);

async function main(argv: readonly string[]): Promise<number> {
  if (argv.some((arg) => !KNOWN_FLAGS.has(arg))) {
    process.stderr.write(
      "usage: pnpm keycloak:reconcile [--check] [--allow-remote]\n",
    );
    return 2;
  }
  const mode = argv.includes("--check") ? "check" : "apply";
  const target = targetOf(
    process.env.KEYCLOAK_ISSUER ?? "",
    argv.includes("--allow-remote"),
  );
  const username = process.env.KEYCLOAK_ADMIN_USERNAME ?? "";
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD ?? "";
  if (username === "" || password === "") {
    process.stderr.write(
      "keycloak:reconcile: KEYCLOAK_ADMIN_USERNAME and KEYCLOAK_ADMIN_PASSWORD are required\n",
    );
    return 2;
  }
  const desired = desiredSettings(loadRealm());
  let token: string | undefined;
  const admin = realmAdmin(target, async () => {
    token ??= await passwordToken(target.base, username, password);
    return token;
  });
  const result = await reconcile(admin, desired, mode);
  for (const line of report(result, mode)) process.stdout.write(`${line}\n`);
  return mode === "check" && result.drift.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      error instanceof ReconcileError
        ? `${error.message}\n`
        : "keycloak:reconcile: failed\n",
    );
    process.exitCode = 2;
  },
);

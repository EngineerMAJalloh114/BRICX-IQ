// Authentication (P5-02, ADR 0062): the global AuthGuard and what it
// needs. Production (bootstrap.ts) passes the config, the request pool and
// the system clock only: the user directory provisions through Postgres,
// the grants source is noGrants (until P5-05) and the JWKS settings are
// JWKS_DEFAULTS. Tests may replace the directory, the grants source, the
// clock and the JWKS settings through createApp's test-only options.
import type { ApiConfig } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Clock } from "../clock.js";
import { AuthGuard } from "./auth.guard.js";
import { GRANTS_SOURCE, type GrantsSource, noGrants } from "./grants-source.js";
import {
  JWKS_DEFAULTS,
  type JwksOptions,
  TokenVerifier,
} from "./token-verifier.js";
import {
  DatabaseUserDirectory,
  USER_DIRECTORY,
  type UserDirectory,
} from "./user-directory.js";

export interface AuthModuleOptions {
  readonly auth: ApiConfig["auth"];
  readonly database: Database;
  readonly clock: Clock;
  /** Test-only overrides (never set by bootstrap.ts). */
  readonly jwks?: Partial<JwksOptions> | undefined;
  readonly userDirectory?: UserDirectory | undefined;
  readonly grantsSource?: GrantsSource | undefined;
}

@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const { auth, database, clock } = options;
    return {
      module: AuthModule,
      providers: [
        {
          provide: TokenVerifier,
          useValue: new TokenVerifier(
            {
              issuer: auth.issuer,
              audience: auth.audience,
              jwksUrl: auth.jwksUrl,
            },
            clock,
            { ...JWKS_DEFAULTS, ...options.jwks },
          ),
        },
        {
          provide: USER_DIRECTORY,
          useValue:
            options.userDirectory ??
            new DatabaseUserDirectory(
              database,
              clock,
              auth.lastSeenThrottleSeconds,
            ),
        },
        { provide: GRANTS_SOURCE, useValue: options.grantsSource ?? noGrants },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}

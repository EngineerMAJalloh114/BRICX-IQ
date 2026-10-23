// Authentication (P5-02, ADR 0062): the global AuthGuard and what it
// needs. Production (bootstrap.ts) passes the config, the request pool and
// the system clock only: the user directory provisions through Postgres,
// the grants source reads the membership rows (P5-05, ADR 0066,
// DbGrantsSource), the JWKS settings are
// JWKS_DEFAULTS, the session tracker writes bricx.sessions (P5-03, ADR
// 0063), the org session policy is the realm's (until P6-03) and the
// revocation store reads Valkey (P5-04, ADR 0065). Tests may replace the
// directory, the tracker, the policy, the store, the grants source, the
// clock and the JWKS settings through createApp's test-only options.
// P5-07 (ADR 0068): the authorization guard (can.guard.ts) runs after the
// AuthGuard on every route.
import type { ApiConfig } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { CLOCK, type Clock } from "../clock.js";
import { AuthGuard } from "./auth.guard.js";
import { CanGuard } from "./can.guard.js";
import {
  DbGrantsSource,
  GRANTS_SOURCE,
  type GrantsSource,
} from "./grants-source.js";
import {
  REVOCATION_STORE,
  type RevocationStore,
  ValkeyRevocationStore,
} from "./revocation-store.js";
import {
  ORG_SESSION_POLICY,
  type OrgSessionPolicy,
  realmSessionPolicy,
} from "./session-policy.js";
import {
  DatabaseSessionTracker,
  SESSION_TRACKER,
  type SessionTracker,
} from "./session-tracker.js";
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
  /** The Valkey URL the revocation store reads (P5-04). */
  readonly valkey: ApiConfig["valkey"];
  readonly clock: Clock;
  /** Test-only overrides (never set by bootstrap.ts). */
  readonly jwks?: Partial<JwksOptions> | undefined;
  readonly userDirectory?: UserDirectory | undefined;
  readonly sessionTracker?: SessionTracker | undefined;
  readonly sessionPolicy?: OrgSessionPolicy | undefined;
  readonly revocationStore?: RevocationStore | undefined;
  readonly grantsSource?: GrantsSource | undefined;
}

@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const { auth, database, clock } = options;
    return {
      module: AuthModule,
      // Global, so feature modules inject the app's Clock (CLOCK) without
      // importing this module: the sessions and devices modules (P5-03,
      // ADR 0063) stamp rows on the same clock the guard judges them by;
      // the sessions module's assertSessionActive() (P5-04) judges a
      // session by the same policy and the same revocation store.
      global: true,
      exports: [CLOCK, ORG_SESSION_POLICY, REVOCATION_STORE],
      providers: [
        { provide: CLOCK, useValue: clock },
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
        {
          provide: ORG_SESSION_POLICY,
          useValue: options.sessionPolicy ?? realmSessionPolicy,
        },
        {
          provide: SESSION_TRACKER,
          useValue:
            options.sessionTracker ??
            new DatabaseSessionTracker(
              database,
              clock,
              options.sessionPolicy ?? realmSessionPolicy,
              auth.lastSeenThrottleSeconds,
            ),
        },
        {
          provide: REVOCATION_STORE,
          useValue:
            options.revocationStore ??
            new ValkeyRevocationStore(options.valkey.url),
        },
        {
          provide: GRANTS_SOURCE,
          useValue: options.grantsSource ?? new DbGrantsSource(database, clock),
        },
        // Global guards run in this order: authentication, then the
        // authorization guard (P5-07, ADR 0068), which needs the identity.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: CanGuard },
      ],
    };
  }
}

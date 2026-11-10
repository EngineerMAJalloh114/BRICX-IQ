// The denial recorder's module (P6-06, ADR 0077, D17, C8): global, so the
// invitations module and the memberships module (the self-change guard,
// C5) record refusals the same way. The Valkey client is the app's shared
// one (createApp's), passed in.
import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { AuditModule } from "./audit.module.js";
import { DENIALS_VALKEY, DenialRecorder } from "./denials.js";

@Global()
@Module({})
export class DenialsModule {
  static forRoot(valkey: Redis): DynamicModule {
    return {
      module: DenialsModule,
      imports: [AuditModule],
      providers: [
        { provide: DENIALS_VALKEY, useValue: valkey },
        DenialRecorder,
      ],
      exports: [DenialRecorder],
    };
  }
}

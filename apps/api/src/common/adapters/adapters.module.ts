// The adapter registry in the API (P6-04, ADR 0074, D11): createApp()
// builds it from code before anything else, with the validated config's
// nodeEnv (owner condition C2), and refuses to start when it is broken.
// This global module only provides the built, frozen registry under
// ADAPTER_REGISTRY; region configuration checks adapter ids against it
// (D9).
import type { AdapterRegistry } from "@bricx/adapters/registry";
import { type DynamicModule, Global, Module } from "@nestjs/common";

/** The injection token of the built registry. */
export const ADAPTER_REGISTRY = Symbol("ADAPTER_REGISTRY");

@Global()
@Module({})
export class AdaptersModule {
  static forRoot(registry: AdapterRegistry): DynamicModule {
    return {
      module: AdaptersModule,
      providers: [{ provide: ADAPTER_REGISTRY, useValue: registry }],
      exports: [ADAPTER_REGISTRY],
    };
  }
}

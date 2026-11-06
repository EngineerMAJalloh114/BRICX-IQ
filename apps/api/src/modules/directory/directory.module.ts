// Stub (P6-01): the tests come first.
import type { DirectoryReader } from "@bricx/db/directory";
import { type DynamicModule, Module } from "@nestjs/common";

export interface DirectoryModuleOptions {
  readonly reader: DirectoryReader;
}

@Module({})
export class DirectoryModule {
  static forRoot(options: DirectoryModuleOptions): DynamicModule {
    return {
      module: DirectoryModule,
      providers: [],
      exports: [],
      global: Object.isFrozen(options),
    };
  }
}

// The global directory module (P6-01, ADR 0071; owner condition C4). It
// stands alone: its only dependency is the directory_reader handle, so its
// DI graph builds from @bricx/config/directory alone, with nothing from
// the cell (test/modules/directory.test.ts). createApp registers it only
// when DIRECTORY_DATABASE_URL is set. The reader is closed on shutdown.
import type { DirectoryReader } from "@bricx/db/directory";
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { DirectoryController } from "./directory.controller.js";
import { DIRECTORY_READER } from "./directory.tokens.js";

export interface DirectoryModuleOptions {
  /** The directory_reader handle (openDirectoryReader). */
  readonly reader: DirectoryReader;
}

class DirectoryLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DIRECTORY_READER) private readonly reader: DirectoryReader,
  ) {}

  private readonly logger = new Logger("Directory");

  async onApplicationShutdown() {
    await this.reader.close();
    this.logger.log("directory reader closed");
  }
}

@Module({})
export class DirectoryModule {
  static forRoot(options: DirectoryModuleOptions): DynamicModule {
    return {
      module: DirectoryModule,
      controllers: [DirectoryController],
      providers: [
        { provide: DIRECTORY_READER, useValue: options.reader },
        DirectoryLifecycle,
      ],
    };
  }
}

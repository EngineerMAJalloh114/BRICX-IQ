// The SoD module (P5-07, ADR 0068): SodService, for the modules whose
// records form approval chains (finance and supply, P9). Global, so a
// module injects SodService without importing this one; it has no
// controller and no table of its own beyond bricx.sod_actions
// (@bricx/db/sod).
import { Global, Module } from "@nestjs/common";
import { SodService } from "./sod.service.js";

@Global()
@Module({ providers: [SodService], exports: [SodService] })
export class SodModule {}

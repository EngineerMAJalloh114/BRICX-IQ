// Devices' routes (P5-03, ADR 0063), under /v1/devices:
//   POST   /      @RegistersDevice() register this device (201; the header
//                 X-Device-Id must equal the body id)
//   GET    /      the caller's devices
//   DELETE /:id   revoke the caller's device and its sessions (204)
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { NoPermission } from "../../common/auth/can.decorator.js";
import { RegistersDevice } from "../../common/auth/registers-device.decorator.js";
import {
  Device,
  DeviceList,
  DeviceParams,
  RegisterDevice,
} from "./devices.dto.js";
import { DevicesService, type DevicesPort } from "./devices.service.js";

@Controller({ path: "devices", version: "1" })
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly service: DevicesPort) {}

  @Post()
  @NoPermission("registers the caller's own device")
  @RegistersDevice()
  @ZodResponse({ status: 201, type: Device })
  register(@Body() body: RegisterDevice) {
    return this.service.register(body);
  }

  @Get()
  @NoPermission("the caller's own devices")
  @ZodResponse({ status: 200, type: DeviceList })
  async list() {
    return { items: await this.service.listMine() };
  }

  @Delete(":id")
  @NoPermission("revokes one of the caller's own devices")
  @HttpCode(204)
  revoke(@Param() params: DeviceParams) {
    return this.service.revoke(params.id);
  }
}

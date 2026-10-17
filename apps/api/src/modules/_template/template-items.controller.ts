// TemplateItems' routes (P4-09, ADR 0059), under /v1/template-items:
//   POST /       @Idempotent() create (201), @ZodResponse; 409 on a
//                duplicate name or id
//   GET  /:id    one item (404 not_found outside the caller's reach)
//   GET  /       one project's items, cursor-paged
// The handlers only parse and delegate; the service does the rest.
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Idempotent } from "../../common/idempotency/decorator.js";
import {
  CreateTemplateItem,
  ListTemplateItemsQuery,
  TemplateItem,
  TemplateItemPage,
  TemplateItemParams,
} from "./template-items.dto.js";
import { TemplateItemsService } from "./template-items.service.js";

@Controller({ path: "template-items", version: "1" })
export class TemplateItemsController {
  constructor(
    @Inject(TemplateItemsService)
    private readonly service: TemplateItemsService,
  ) {}

  @Post()
  @Idempotent()
  @ZodResponse({ status: 201, type: TemplateItem })
  create(@Body() body: CreateTemplateItem) {
    return this.service.create(body);
  }

  @Get(":id")
  @ZodResponse({ status: 200, type: TemplateItem })
  get(@Param() params: TemplateItemParams) {
    return this.service.get(params.id);
  }

  @Get()
  @ZodResponse({ status: 200, type: TemplateItemPage })
  list(@Query() query: ListTemplateItemsQuery) {
    return this.service.list(query);
  }
}

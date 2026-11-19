// HTTP controller for Access Settings (U20b):
//   GET  /v1/admin/access         (@Can('admin.roles.read'))
//   POST /v1/admin/access/preview (@Can('admin.roles.read'))
//   POST /v1/admin/access         (@Can('admin.roles.write'))
//   GET  /v1/admin/access/check   (@Can('admin.roles.read'))
import {
  AccessPreviewRequestSchema,
  AccessSaveRequestSchema,
  CheckPersonQuerySchema,
  type AccessCatalogueResponse,
  type AccessPreviewResponse,
  type CheckPersonReport,
} from '@bos/contracts';
import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
import { requestTx } from '../../platform/db/tx';
import { AccessSettingsService } from './access-settings.service';

function parseOrBadRequest<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new BadRequestException(`Invalid ${what}: ${fields.join(', ')}`);
  }
  return parsed.data;
}

@Controller('v1/admin/access')
export class AccessSettingsController {
  constructor(private readonly service: AccessSettingsService) {}

  @Get()
  @Can('admin.roles.read')
  async getCatalogue(): Promise<AccessCatalogueResponse> {
    const { scope } = requestTx();
    return this.service.getCatalogue(scope);
  }

  @Post('preview')
  @HttpCode(200)
  @Can('admin.roles.read')
  async preview(@Body() body: unknown): Promise<AccessPreviewResponse> {
    const req = parseOrBadRequest(AccessPreviewRequestSchema, body, 'preview request');
    const { scope } = requestTx();
    return this.service.preview(scope, req);
  }

  @Post()
  @HttpCode(200)
  @Can('admin.roles.write')
  async save(@Body() body: unknown): Promise<AccessCatalogueResponse> {
    const req = parseOrBadRequest(AccessSaveRequestSchema, body, 'access change request');
    const { scope, actor } = requestTx();
    return this.service.save(scope, actor, req);
  }

  @Get('check')
  @Can('admin.roles.read')
  async checkPerson(@Query() query: unknown): Promise<CheckPersonReport> {
    const q = parseOrBadRequest(CheckPersonQuerySchema, query, 'query');
    const { scope } = requestTx();
    return this.service.checkPerson(scope, q.person);
  }
}

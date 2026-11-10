import type { CostCenter } from '@bos/contracts';
import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { AnyAuthenticated, Can } from '../../../platform/authz/decorators';
import { z } from 'zod';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { CostCentersService } from './cost-centers.service';

@Controller('v1/cost-centers')
export class CostCentersController {
  constructor(private readonly costCenters: CostCentersService) {}

  @Get()
  @AnyAuthenticated()
  list(): Promise<CostCenter[]> {
    return this.costCenters.list();
  }

  @Post()
  @Can('admin.settings.write')
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() raw: unknown,
  ): Promise<CostCenter> {
    const body = parseOr400(
      z
        .object({ code: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(200) })
        .strict(),
      raw,
    );
    return this.costCenters.create(body, requireIdempotencyKey(key));
  }

  @Patch(':id')
  @Can('admin.settings.write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() raw: unknown,
  ): Promise<CostCenter> {
    const body = parseOr400(
      z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          active: z.boolean().optional(),
        })
        .strict()
        .refine((b) => b.name !== undefined || b.active !== undefined),
      raw,
    );
    return this.costCenters.update(id, body, requireIdempotencyKey(key));
  }
}

// Routes of the customer and vendor CSV import (round 5, K1), under /v1/imports. Thin on purpose: the upload is read
// here (csv-body.ts), every rule is in PartyImportsService. Starting an import is `customer.write` or `vendor.write`
// (the grant to create one such record by hand), named per route so the deny-by-default sweep sees it; reading and
// committing a batch ask for the grant of the batch's own kind inside the service, because the kind is a property of the
// stored batch. Commit needs no Idempotency-Key: it is idempotent by the batch's status.
//   POST /v1/imports/customers?filename=   body text/csv   201 the previewed batch with its rows
//   POST /v1/imports/vendors?filename=
//   POST /v1/imports/:id/commit                            200 the committed batch (the same body when repeated)
//   GET  /v1/imports/:id                                   200 the batch with its rows
//   GET  /v1/imports?kind=                                 200 the newest batches, without rows
import {
  ListPartyImportsQuerySchema,
  PreviewPartyImportQuerySchema,
  type PartyImportBatch,
  type PartyImportDetail,
} from '@bos/contracts';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { AnyAuthenticated, Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { readCsvBody } from './csv-body';
import { PartyImportsService } from './party-imports.service';

@Controller('v1/imports')
export class PartyImportsController {
  constructor(private readonly imports: PartyImportsService) {}

  @Get()
  @AnyAuthenticated()
  list(@Query() query: unknown): Promise<PartyImportBatch[]> {
    return this.imports.list(parseOr400(ListPartyImportsQuerySchema, query).kind);
  }

  @Post('customers')
  @Can('customer.write')
  async previewCustomers(@Query() query: unknown, @Req() req: Request): Promise<PartyImportDetail> {
    const { filename } = parseOr400(PreviewPartyImportQuerySchema, query);
    return this.imports.preview('customer', filename, await readCsvBody(req));
  }

  @Post('vendors')
  @Can('vendor.write')
  async previewVendors(@Query() query: unknown, @Req() req: Request): Promise<PartyImportDetail> {
    const { filename } = parseOr400(PreviewPartyImportQuerySchema, query);
    return this.imports.preview('vendor', filename, await readCsvBody(req));
  }

  @Post(':id/commit')
  @HttpCode(200)
  @AnyAuthenticated()
  commit(@Param('id', ParseUUIDPipe) id: string): Promise<PartyImportDetail> {
    return this.imports.commit(id);
  }

  @Get(':id')
  @AnyAuthenticated()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PartyImportDetail> {
    return this.imports.get(id);
  }
}

// HTTP route of the quotation preview. Thin on purpose: parsing here, every rule in QuotationPreviewService. The
// route needs quotation.draft (route level); the service then checks the quotation itself (its owner, for the `own`
// scope) and answers 404 for another entity's quotation.
import { QuotationPreviewBodySchema, type PreviewResult } from '@bos/contracts';
import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { QuotationPreviewService } from './quotation-preview.service';

@Controller('v1/quotations')
export class QuotationPreviewController {
  constructor(private readonly previews: QuotationPreviewService) {}

  /**
   * 200 (nothing is created) with `{ totals, taxSummary, lines, nprSnapshot, route }`. Writes nothing. 400 for a
   * bad body or an unknown tax code, 404 for a version outside the caller's entity or scope, 409 unless the version
   * is a draft or returned, or when no approval workflow is published, and 409 `fx_rate_stale` for an old USD rate.
   */
  @Post(':id/versions/:vid/preview')
  @HttpCode(200)
  @Can('quotation.draft')
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
    @Body() body: unknown,
  ): Promise<PreviewResult> {
    return this.previews.preview(id, versionId, parseOr400(QuotationPreviewBodySchema, body));
  }
}

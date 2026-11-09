// REST routes of the vendor bill inbox for staff (P4 unit A1d) under /v1/payables/bill-submissions. Listing needs
// payables.bill.read; converting a submission into a bill and rejecting one need payables.bill.enter (accountants),
// and both take an Idempotency-Key. The vendor portal's view of the bill then follows the bill's own status.
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import {
  ConvertBillSubmissionBodySchema,
  RejectBillSubmissionBodySchema,
} from './bill-submissions.types';
import {
  BillSubmissionsService,
  type BillSubmissionDto,
  type RejectedBillSubmissionDto,
} from './bill-submissions.service';
import { VendorBillsService, type VendorBillDto } from './vendor-bills.service';

@Controller('v1/payables/bill-submissions')
export class BillSubmissionsController {
  constructor(
    private readonly bills: VendorBillsService,
    private readonly submissions: BillSubmissionsService,
  ) {}

  /** The entity's received bill submissions, oldest first. */
  @Get()
  @Can('payables.bill.read')
  list(): Promise<BillSubmissionDto[]> {
    return this.submissions.list();
  }

  /**
   * 201 with the bill made from the submission (matched when it names a PO). 404 outside the acting entity; 409
   * SUBMISSION_NOT_RECEIVED, SUBMISSION_FILE_NOT_CLEAN or DUPLICATE_BILL; 422 for a line the bill refuses.
   */
  @Post(':id/convert')
  @HttpCode(201)
  @Can('payables.bill.enter')
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorBillDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.bills.convertSubmission(
      id,
      parseOr400(ConvertBillSubmissionBodySchema, body),
      idempotencyKey,
    );
  }

  /** 200 with the rejected submission. 400 without a reason; 404 outside the acting entity; 409 once decided. */
  @Post(':id/reject')
  @HttpCode(200)
  @Can('payables.bill.enter')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<RejectedBillSubmissionDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.submissions.reject(
      id,
      parseOr400(RejectBillSubmissionBodySchema, body),
      idempotencyKey,
    );
  }
}

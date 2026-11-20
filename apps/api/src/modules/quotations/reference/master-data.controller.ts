// HTTP routes of Settings > Tax (tax codes) and Settings > Saved terms (payment terms), F1-Q49. Thin: parsing
// here, the rules in MasterDataService. One @Can names one permission and these routes accept either of two
// (settings.finance.write or admin.settings.write), so they carry @AnyAuthenticated and the service checks the
// grant before reading or writing anything.
import {
  ChangeTaxCodeBodySchema,
  CreatePaymentTermBodySchema,
  CreateTaxCodeBodySchema,
  RetireTaxCodeBodySchema,
  TaxCodeCodeSchema,
  UpdatePaymentTermBodySchema,
  type AdminPaymentTerm,
  type AdminTaxCode,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { AnyAuthenticated } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { MasterDataService } from './master-data.service';

/** A code that cannot exist is a missing resource, not a malformed request. */
function taxCode(raw: string): string {
  const parsed = TaxCodeCodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NotFoundException({ code: 'not_found', message: 'Tax code not found' });
  }
  return parsed.data;
}

@Controller('v1/admin')
export class MasterDataController {
  constructor(private readonly masterData: MasterDataService) {}

  /** 200 with every tax code and its periods, oldest first. */
  @Get('tax-codes')
  @AnyAuthenticated()
  listTaxCodes(): Promise<AdminTaxCode[]> {
    return this.masterData.listTaxCodes();
  }

  /** 201 with the new code. 400 bad body or a start before today; 409 the code exists. */
  @Post('tax-codes')
  @HttpCode(201)
  @AnyAuthenticated()
  createTaxCode(@Body() body: unknown): Promise<AdminTaxCode> {
    this.masterData.assertEditor();
    return this.masterData.createTaxCode(parseOr400(CreateTaxCodeBodySchema, body));
  }

  /** 201 with the code and its new period. 404 unknown code; 409 stale or retired; 400 a day too early. */
  @Post('tax-codes/:code/changes')
  @HttpCode(201)
  @AnyAuthenticated()
  changeTaxCode(@Param('code') code: string, @Body() body: unknown): Promise<AdminTaxCode> {
    this.masterData.assertEditor();
    return this.masterData.changeTaxCode(taxCode(code), parseOr400(ChangeTaxCodeBodySchema, body));
  }

  /** 200 with the code, retired from the given day. 404 unknown; 409 stale or already retired. */
  @Post('tax-codes/:code/retire')
  @HttpCode(200)
  @AnyAuthenticated()
  retireTaxCode(@Param('code') code: string, @Body() body: unknown): Promise<AdminTaxCode> {
    this.masterData.assertEditor();
    return this.masterData.retireTaxCode(taxCode(code), parseOr400(RetireTaxCodeBodySchema, body));
  }

  /** 200 with every payment term, retired ones included. */
  @Get('payment-terms')
  @AnyAuthenticated()
  listPaymentTerms(): Promise<AdminPaymentTerm[]> {
    return this.masterData.listPaymentTerms();
  }

  /** 201 with the new term. 409 when its code or name is taken. */
  @Post('payment-terms')
  @HttpCode(201)
  @AnyAuthenticated()
  createPaymentTerm(@Body() body: unknown): Promise<AdminPaymentTerm> {
    this.masterData.assertEditor();
    return this.masterData.createPaymentTerm(parseOr400(CreatePaymentTermBodySchema, body));
  }

  /** 200 with the term. 404 unknown; 409 stale version or a name already used. */
  @Patch('payment-terms/:id')
  @AnyAuthenticated()
  updatePaymentTerm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AdminPaymentTerm> {
    this.masterData.assertEditor();
    return this.masterData.updatePaymentTerm(id, parseOr400(UpdatePaymentTermBodySchema, body));
  }
}

// HTTP routes of a vendor's bank accounts (P4 V2, AD9). Thin on purpose: validation here, every rule in
// VendorBankService. Each route names its permission with @Can and the service checks the record. Every POST
// needs an Idempotency-Key. Responses are VendorBankAccountDto: the last four digits only, never the number.
import {
  ProposeBankAccountBodySchema,
  RejectBankAccountBodySchema,
  VerifyBankAccountBodySchema,
  type VendorBankAccountDto,
} from '@bos/contracts';
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
import { stripAccountSpaces } from './bank.rules';
import { VendorBankService } from './bank.service';

@Controller('v1/vendors/:id/bank-accounts')
export class VendorBankController {
  constructor(private readonly bank: VendorBankService) {}

  /** 200 with the vendor's accounts, newest first. */
  @Get()
  @Can('vendor.read')
  list(@Param('id', ParseUUIDPipe) id: string): Promise<VendorBankAccountDto[]> {
    return this.bank.list(id);
  }

  @Get(':accountId')
  @Can('vendor.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ): Promise<VendorBankAccountDto> {
    return this.bank.get(id, accountId);
  }

  /** 201 with the proposed account. Spaces in the account number are stripped before validation. */
  @Post()
  @Can('vendor.bank.propose')
  propose(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorBankAccountDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.bank.propose(
      id,
      parseOr400(ProposeBankAccountBodySchema, stripAccountSpaces(body)),
      key,
    );
  }

  /**
   * 200 with the now active account (the previous active one is retired). 403 `separation_of_duties` for the
   * proposer; 409 when the account is not proposed or the evidence is not a clean document of this account.
   */
  @Post(':accountId/verify')
  @HttpCode(200)
  @Can('vendor.bank.verify')
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorBankAccountDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.bank.verify(id, accountId, parseOr400(VerifyBankAccountBodySchema, body), key);
  }

  /** 200 with the rejected account. 409 when it is not proposed. */
  @Post(':accountId/reject')
  @HttpCode(200)
  @Can('vendor.bank.verify')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorBankAccountDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.bank.reject(id, accountId, parseOr400(RejectBankAccountBodySchema, body), key);
  }
}

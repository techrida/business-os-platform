// HTTP routes of Settings > Finance > Bank and expense accounts (round 5, unit P1). Thin: parsing here, the rules
// in CompanyAccountsService. Writes accept either of two permissions (settings.finance.write or
// admin.settings.write, the same pair the workspace gates the page on) and one @Can names one permission, so they
// carry @AnyAuthenticated and check the grant before parsing, like the Settings > Tax routes.
import {
  CreateCompanyBankAccountBodySchema,
  CreateExpenseAccountBodySchema,
  RenameCompanyBankAccountBodySchema,
  RenameExpenseAccountBodySchema,
  type CompanyBankAccount,
  type ExpenseAccount,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { CompanyAccountsService } from './company-accounts.service';

const IncludeRetiredSchema = z.enum(['true', 'false']).optional();
const includeRetired = (raw: unknown): boolean => parseOr400(IncludeRetiredSchema, raw) === 'true';

@Controller('v1/company-bank-accounts')
export class CompanyBankAccountsController {
  constructor(private readonly accounts: CompanyAccountsService) {}

  /** 200 with the active rows; `?includeRetired=true` adds retired ones. Any active staff user; portal 403. */
  @Get()
  @AnyAuthenticated()
  list(@Query('includeRetired') raw: unknown): Promise<CompanyBankAccount[]> {
    return this.accounts.listBankAccounts(includeRetired(raw));
  }

  /** 201 with the new row. 400 bad body or missing Idempotency-Key. */
  @Post()
  @HttpCode(201)
  @AnyAuthenticated()
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() raw: unknown,
  ): Promise<CompanyBankAccount> {
    this.accounts.assertEditor();
    const body = parseOr400(CreateCompanyBankAccountBodySchema, raw);
    return this.accounts.createBankAccount(body, requireIdempotencyKey(key));
  }

  /** 200 with the renamed row. 404 unknown id or another company's. */
  @Patch(':id')
  @AnyAuthenticated()
  rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() raw: unknown,
  ): Promise<CompanyBankAccount> {
    this.accounts.assertEditor();
    const { name } = parseOr400(RenameCompanyBankAccountBodySchema, raw);
    return this.accounts.renameBankAccount(id, name, requireIdempotencyKey(key));
  }

  /** 200 with the retired row; retiring a retired row answers it unchanged. */
  @Post(':id/retire')
  @HttpCode(200)
  @AnyAuthenticated()
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<CompanyBankAccount> {
    this.accounts.assertEditor();
    return this.accounts.setBankAccountStatus(id, 'retired', requireIdempotencyKey(key));
  }

  /** 200 with the active row; reactivating an active row answers it unchanged. */
  @Post(':id/reactivate')
  @HttpCode(200)
  @AnyAuthenticated()
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<CompanyBankAccount> {
    this.accounts.assertEditor();
    return this.accounts.setBankAccountStatus(id, 'active', requireIdempotencyKey(key));
  }
}

@Controller('v1/expense-accounts')
export class ExpenseAccountsController {
  constructor(private readonly accounts: CompanyAccountsService) {}

  /** 200 with the active rows; `?includeRetired=true` adds retired ones. Any active staff user; portal 403. */
  @Get()
  @AnyAuthenticated()
  list(@Query('includeRetired') raw: unknown): Promise<ExpenseAccount[]> {
    return this.accounts.listExpenseAccounts(includeRetired(raw));
  }

  /** 201 with the new row. 400 bad body; 409 the code exists in this company (case-insensitive). */
  @Post()
  @HttpCode(201)
  @AnyAuthenticated()
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() raw: unknown,
  ): Promise<ExpenseAccount> {
    this.accounts.assertEditor();
    const body = parseOr400(CreateExpenseAccountBodySchema, raw);
    return this.accounts.createExpenseAccount(body, requireIdempotencyKey(key));
  }

  /** 200 with the renamed row. 404 unknown id or another company's. */
  @Patch(':id')
  @AnyAuthenticated()
  rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() raw: unknown,
  ): Promise<ExpenseAccount> {
    this.accounts.assertEditor();
    const { name } = parseOr400(RenameExpenseAccountBodySchema, raw);
    return this.accounts.renameExpenseAccount(id, name, requireIdempotencyKey(key));
  }

  @Post(':id/retire')
  @HttpCode(200)
  @AnyAuthenticated()
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<ExpenseAccount> {
    this.accounts.assertEditor();
    return this.accounts.setExpenseAccountStatus(id, 'retired', requireIdempotencyKey(key));
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @AnyAuthenticated()
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<ExpenseAccount> {
    this.accounts.assertEditor();
    return this.accounts.setExpenseAccountStatus(id, 'active', requireIdempotencyKey(key));
  }
}

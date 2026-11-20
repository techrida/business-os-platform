// HTTP routes of the vendors. Thin on purpose: validation here, every rule in VendorsService. Serves the NFR
// "authorization is deny-by-default": each route names its permission with @Can (does the role hold it at all),
// and the service then checks the record (a vendor is tenant-level, so the record check is the scope of the
// grant). Every POST needs an Idempotency-Key, so a double click or a retry cannot act twice.
import {
  CreateVendorBodySchema,
  VendorContactBodySchema,
  type VendorAccountDto,
  type VendorDto,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey, sentFields } from '../customers/customers.types';
import { VendorsService } from './vendors.service';
import {
  CreateVendorAccountBodySchema,
  ListVendorsQuerySchema,
  SubmitKycBodySchema,
  UpdateVendorBodySchema,
  UpdateVendorContactBodySchema,
  VendorNameMatchesQuerySchema,
  VendorReasonBodySchema,
  type VendorContactDto,
  type VendorList,
  type VendorNameMatches,
  type VendorReviewReadiness,
} from './vendors.types';

@Controller('v1/vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  /** 200 with `{ items, total }`: the page of VendorDto and the full count of the filter. */
  @Get()
  @Can('vendor.read')
  list(@Query() query: Record<string, unknown>): Promise<VendorList> {
    return this.vendors.list(parseOr400(ListVendorsQuerySchema, query));
  }

  /**
   * 200 `{ matches }`: the vendors whose legal name matches `?legalName=` once case, spaces, punctuation and
   * company-form words are ignored. For the add form's warning (TR-Q12d); a create is never refused for a name.
   * Declared before `:id` so the static path is not read as an id.
   */
  @Get('name-matches')
  @Can('vendor.read')
  nameMatches(@Query() query: Record<string, unknown>): Promise<VendorNameMatches> {
    return this.vendors.nameMatches(parseOr400(VendorNameMatchesQuerySchema, query));
  }

  /** 201 with the new VendorDto (status draft). 409 `duplicate_pan` for a PAN the tenant already holds. */
  @Post()
  @Can('vendor.write')
  create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.vendors.create(parseOr400(CreateVendorBodySchema, body), key);
  }

  @Get(':id')
  @Can('vendor.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VendorDto> {
    return this.vendors.get(id);
  }

  /** 200 `{ kybSubmitted }`: whether "Send for review" (pending_kyc -> under_review) would be taken now. */
  @Get(':id/review-readiness')
  @Can('vendor.read')
  reviewReadiness(@Param('id', ParseUUIDPipe) id: string): Promise<VendorReviewReadiness> {
    return this.vendors.reviewReadiness(id);
  }

  /** 200 with the updated VendorDto. 409 when `expectedVersion` is stale. Only the keys sent are changed. */
  @Patch(':id')
  @Can('vendor.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<VendorDto> {
    const parsed = parseOr400(UpdateVendorBodySchema, body);
    const { expectedVersion, ...fields } = sentFields(body, parsed);
    return this.vendors.update(id, expectedVersion ?? parsed.expectedVersion, fields);
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  /**
   * draft -> pending_kyc (opens the KYB case); pending_kyc -> under_review once the case is submitted. Body
   * `{ expectedStatus? }`: 409 when the vendor is no longer in that status (a stale button in another tab).
   */
  @Post(':id/submit-kyc')
  @HttpCode(200)
  @Can('vendor.write')
  submitKyc(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorDto> {
    const { expectedStatus } = parseOr400(SubmitKycBodySchema, body ?? {});
    return this.vendors.submitKyc(id, requireIdempotencyKey(idempotencyKey), expectedStatus);
  }

  /** 200 approved. 409 without an approved KYB case; 403 for the vendor's creator. */
  @Post(':id/activate')
  @HttpCode(200)
  @Can('vendor.activate')
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<VendorDto> {
    return this.vendors.lifecycle(id, 'activate', undefined, requireIdempotencyKey(idempotencyKey));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @Can('vendor.activate')
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorDto> {
    const { reason } = parseOr400(VendorReasonBodySchema, body);
    return this.vendors.lifecycle(id, 'suspend', reason, requireIdempotencyKey(idempotencyKey));
  }

  @Post(':id/block')
  @HttpCode(200)
  @Can('vendor.activate')
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorDto> {
    const { reason } = parseOr400(VendorReasonBodySchema, body);
    return this.vendors.lifecycle(id, 'block', reason, requireIdempotencyKey(idempotencyKey));
  }

  /** Only a blocked vendor can be archived (the contract's state machine). */
  @Post(':id/archive')
  @HttpCode(200)
  @Can('vendor.activate')
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorDto> {
    const { reason } = parseOr400(VendorReasonBodySchema, body);
    return this.vendors.lifecycle(id, 'archive', reason, requireIdempotencyKey(idempotencyKey));
  }

  // -------------------------------------------------------------------------------------------- contacts

  @Get(':id/contacts')
  @Can('vendor.read')
  contacts(@Param('id', ParseUUIDPipe) id: string): Promise<VendorContactDto[]> {
    return this.vendors.listContacts(id);
  }

  /** 201 with the new contact; the first contact of a vendor is its primary one. */
  @Post(':id/contacts')
  @Can('vendor.write')
  createContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorContactDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.vendors.createContact(id, parseOr400(VendorContactBodySchema, body), key);
  }

  @Patch(':id/contacts/:contactId')
  @Can('vendor.write')
  updateContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() body: unknown,
  ): Promise<VendorContactDto> {
    const parsed = parseOr400(UpdateVendorContactBodySchema, body);
    const { expectedVersion, ...fields } = sentFields(body, parsed);
    return this.vendors.updateContact(
      id,
      contactId,
      expectedVersion ?? parsed.expectedVersion,
      fields,
    );
  }

  @Delete(':id/contacts/:contactId')
  @HttpCode(204)
  @Can('vendor.write')
  deleteContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ): Promise<void> {
    return this.vendors.deleteContact(id, contactId);
  }

  // -------------------------------------------------------------------------------------------- accounts

  /** The vendor's account with the acting entity (an entity sees its own terms only). */
  @Get(':id/accounts')
  @Can('vendor.read')
  accounts(@Param('id', ParseUUIDPipe) id: string): Promise<VendorAccountDto[]> {
    return this.vendors.listAccounts(id);
  }

  /** 404 for any entity other than the acting one. */
  @Get(':id/accounts/:organizationId')
  @Can('vendor.read')
  account(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<VendorAccountDto> {
    return this.vendors.getAccount(id, organizationId);
  }

  /** 201 with the account. 404 for an entity the caller is not a member of; 409 `account_exists`. */
  @Post(':id/accounts')
  @Can('vendor.write')
  createAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorAccountDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.vendors.createAccount(id, parseOr400(CreateVendorAccountBodySchema, body), key);
  }
}

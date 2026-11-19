// HTTP routes of the customers. Thin on purpose: validation here, every rule in CustomersService. Serves the NFR
// "authorization is deny-by-default": each route names its permission with @Can (does the role hold it at all),
// and the service then checks the record (a customer is tenant-level, so the record check is the scope of the
// grant). Both creates need an Idempotency-Key, so a double click or a retry cannot create twice.
import {
  CreateContactBodySchema,
  CreateCustomerBodySchema,
  UpdateCustomerBodySchema,
  type ContactDto,
  type CustomerDto,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { CustomersService } from './customers.service';
import {
  ListCustomersQuerySchema,
  requireIdempotencyKey,
  sentFields,
  type CustomerDetailDto,
  type CustomerList,
} from './customers.types';

@Controller('v1/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  /** 200 with `{ items, total }`: the page of CustomerDto and the full count of the search. */
  @Get()
  @Can('customer.read')
  list(@Query() query: Record<string, unknown>): Promise<CustomerList> {
    return this.customers.list(parseOr400(ListCustomersQuerySchema, query));
  }

  /** 200 with the industries in use among the customers the caller may read (for the list filter). */
  @Get('industries')
  @Can('customer.read')
  industries(): Promise<string[]> {
    return this.customers.industries();
  }

  /** 201 with the new CustomerDto. 409 for a PAN/VAT number another customer already holds. */
  @Post()
  @Can('customer.write')
  create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<CustomerDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.customers.create(parseOr400(CreateCustomerBodySchema, body), key);
  }

  /** 200 with the CustomerDto plus `accounts` (staff only). 404 for a customer of another tenant. */
  @Get(':id')
  @Can('customer.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDetailDto> {
    return this.customers.get(id);
  }

  /** 200 with the updated CustomerDto. 409 when `expectedVersion` is stale. Only the keys sent are changed. */
  @Patch(':id')
  @Can('customer.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<CustomerDto> {
    const parsed = parseOr400(UpdateCustomerBodySchema, body);
    const { expectedVersion, ...fields } = sentFields(body, parsed);
    return this.customers.update(id, expectedVersion ?? parsed.expectedVersion, fields);
  }

  /** 200 with the contacts of the customer, the primary one first. */
  @Get(':id/contacts')
  @Can('customer.read')
  contacts(@Param('id', ParseUUIDPipe) id: string): Promise<ContactDto[]> {
    return this.customers.listContacts(id);
  }

  /** 201 with the new ContactDto. 409 when the customer already has a primary contact. */
  @Post(':id/contacts')
  @Can('customer.write')
  createContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ContactDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.customers.createContact(id, parseOr400(CreateContactBodySchema, body), key);
  }
}

// Request and response shapes that only the customers routes use. The bodies and DTOs live in
// @bos/contracts (crm.ts); the list query, the detail response and the header rule are local. Serves the NFR
// "inputs are validated at the edge" and "no double effects" (Idempotency-Key on every create).
import {
  CUSTOMER_LIST_MAX_LIMIT,
  CustomerRelationshipSchema,
  limitOffset,
  multi,
  searchParam,
  type CustomerDto,
  type PartyAccountDto,
} from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * GET /v1/customers?q&relationship&industry&limit&offset. `relationship` and `industry` may repeat
 * (`?relationship=active&relationship=prospect`); values within one filter are OR-ed, filters are AND-ed.
 * Query values arrive as strings; a repeated `q`, an unknown relationship or an unknown key is a 400.
 */
export const ListCustomersQuerySchema = z.strictObject({
  q: searchParam,
  relationship: multi(CustomerRelationshipSchema),
  industry: multi(z.string().trim().min(1).max(100)),
  ...limitOffset({ max: CUSTOMER_LIST_MAX_LIMIT, fallback: 50 }),
});
export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;

/** GET /v1/customers: the page and the full count, so the workspace can say "of 41". */
export interface CustomerList {
  items: CustomerDto[];
  total: number;
}

/** GET /v1/customers/:id: the customer plus its terms with the legal entities the caller can act for (staff only). */
export type CustomerDetailDto = CustomerDto & { accounts?: PartyAccountDto[] };

/** Printable ASCII, 1 to 200 characters (a UUID from the client is the expected value). Same rule as approvals. */
const IdempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);

/** The Idempotency-Key header, or 400: a create without one could run twice on a retry. */
export function requireIdempotencyKey(header: string | undefined): string {
  if (header === undefined || !IdempotencyKeySchema.safeParse(header).success) {
    throw new BadRequestException(
      'The Idempotency-Key header is required (1-200 printable characters)',
    );
  }
  return header;
}

/**
 * The fields the client actually sent. Zod 4 applies a `.default()` inside `.partial()`, so a parsed PATCH body
 * of `{ expectedVersion: 3 }` carries `relationship: 'prospect'` and would reset an active customer. Only a key
 * that is present in the raw body is an edit.
 */
export function sentFields<T extends object>(raw: unknown, parsed: T): Partial<T> {
  const sent = typeof raw === 'object' && raw !== null ? raw : {};
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => Object.hasOwn(sent, key)),
  ) as Partial<T>;
}

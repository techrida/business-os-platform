// Request and response shapes that only the customers routes use. The bodies and DTOs live in
// @bos/contracts (crm.ts); the list query, the detail response and the header rule are local. Serves the NFR
// "inputs are validated at the edge" and "no double effects" (Idempotency-Key on every create).
import {
  CUSTOMER_LIST_MAX_LIMIT,
  type CustomerDto,
  type PartyAccountDto,
  type PersonName,
} from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const digits = (max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().max(max));

/** GET /v1/customers?q&limit&offset. Query values arrive as strings; a repeated key (an array) is a 400. */
export const ListCustomersQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  limit: digits(CUSTOMER_LIST_MAX_LIMIT)
    .refine((n) => n >= 1, 'must be at least 1')
    .optional(),
  offset: digits(1_000_000).optional(),
});
export interface ListCustomersQuery {
  q: string | undefined;
  limit: number;
  offset: number;
}
export const DEFAULT_LIMIT = 50;

export function listQueryOf(parsed: z.infer<typeof ListCustomersQuerySchema>): ListCustomersQuery {
  const q = parsed.q === undefined || parsed.q === '' ? undefined : parsed.q;
  return { q, limit: parsed.limit ?? DEFAULT_LIMIT, offset: parsed.offset ?? 0 };
}

/** GET /v1/customers: the page and the full count, so the workspace can say "of 41". */
export interface CustomerList {
  items: CustomerDto[];
  total: number;
}

/**
 * GET /v1/customers/:id: the customer plus, for staff only, its terms with the legal entities the caller can act
 * for and the name of its account owner (`people`), so the page needs no admin directory to label the owner.
 */
export type CustomerDetailDto = CustomerDto & { accounts?: PartyAccountDto[]; people?: PersonName[] };

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

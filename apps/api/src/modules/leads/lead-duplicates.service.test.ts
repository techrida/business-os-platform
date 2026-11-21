// LeadDuplicatesService with a failing database: a driver error must not carry the typed email, phone, name or
// company out of the service (Drizzle's query error puts the bound params in its message, and an unhandled error is
// logged with its message, stack and cause). The lookup itself is covered by lead-duplicates.integration.test.ts.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/lead-duplicates.service.test.ts
import { ForbiddenException } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Db } from '../../platform/db/db.module';
import type { LeadsCaller } from './leads.caller';
import { LeadDuplicatesService } from './lead-duplicates.service';

const typed = {
  email: 'ram.thapa@example.com',
  phone: '+977 9800000001',
  name: 'Ram Thapa',
  company: 'Thapa Traders',
};

/** A database whose transaction fails the way the driver does: the SQL and its bound params in the message. */
const failingDb = (error: Error) => ({ transaction: () => Promise.reject(error) }) as unknown as Db;

const caller = { current: () => ({}) } as unknown as LeadsCaller;

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to fail');
}

describe('LeadDuplicatesService.find on a database error', () => {
  it('rethrows a generic error without the bound values, the query or the cause', async () => {
    const driver = new DrizzleQueryError(
      'select "id" from "app"."leads" where "email_norm" = $1 or right("phone_e164", $2) = $3',
      [typed.email, 10, '9800000001', typed.name, typed.company],
      new Error(`invalid input near "${typed.name}"`),
    );
    expect(driver.message).toContain(typed.email);

    const thrown = await errorOf(new LeadDuplicatesService(failingDb(driver), caller).find(typed));

    expect(thrown).not.toBe(driver);
    expect(thrown.message).toBe('The lead duplicate lookup failed');
    expect(thrown.cause).toBeUndefined();
    const everything = `${thrown.message}\n${thrown.stack ?? ''}\n${JSON.stringify(thrown)}`;
    for (const value of [typed.email, '9800000001', typed.name, typed.company, 'email_norm']) {
      expect(everything).not.toContain(value);
    }
  });

  it('passes an HTTP error through unchanged', async () => {
    const forbidden = new ForbiddenException();
    const thrown = await errorOf(
      new LeadDuplicatesService(failingDb(forbidden), caller).find(typed),
    );
    expect(thrown).toBe(forbidden);
  });
});

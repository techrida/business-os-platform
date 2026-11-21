// The customer terms contracts (R4a Q12): the body of PATCH /v1/customers/:id/terms and the detail's terms flags.
import { describe, expect, it } from 'vitest';

import { UpdateCustomerTermsBodySchema } from './crm.js';
import { CustomerActingEntitySchema, CustomerCanSchema } from './customer-detail.js';

const TERM = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const ok = (body: unknown) => UpdateCustomerTermsBodySchema.safeParse(body).success;

describe('UpdateCustomerTermsBodySchema', () => {
  it('takes a limit, a term, or both, with or without the version', () => {
    expect(ok({ creditLimit: '500000.00' })).toBe(true);
    expect(ok({ creditLimit: '500000', expectedVersion: 2 })).toBe(true);
    expect(ok({ paymentTermId: TERM })).toBe(true);
    expect(ok({ paymentTermId: TERM, creditLimit: '0.5', expectedVersion: 1 })).toBe(true);
  });

  it('keeps null (no limit, no term) apart from "0.00" (a limit that holds everything)', () => {
    expect(UpdateCustomerTermsBodySchema.parse({ creditLimit: null })).toEqual({
      creditLimit: null,
    });
    expect(UpdateCustomerTermsBodySchema.parse({ creditLimit: '0.00' })).toEqual({
      creditLimit: '0.00',
    });
    expect(UpdateCustomerTermsBodySchema.parse({ paymentTermId: null })).toEqual({
      paymentTermId: null,
    });
  });

  it('refuses three decimals, a negative or signed amount, a number and a non-amount', () => {
    for (const creditLimit of ['1.005', '-1.00', '+1.00', '1e5', '', ' 10', 'abc', 1000]) {
      expect(ok({ creditLimit }), String(creditLimit)).toBe(false);
    }
  });

  it('needs one of the two fields, a uuid term, a positive integer version and no other key', () => {
    expect(ok({})).toBe(false);
    expect(ok({ expectedVersion: 1 })).toBe(false);
    expect(ok({ paymentTermId: 'net-30' })).toBe(false);
    expect(ok({ creditLimit: '1.00', expectedVersion: 0 })).toBe(false);
    expect(ok({ creditLimit: '1.00', expectedVersion: 1.5 })).toBe(false);
    expect(ok({ creditLimit: '1.00', ownerUserId: TERM })).toBe(false);
  });
});

describe('CustomerCanSchema terms flags', () => {
  it('reads a missing flag as false (deny by default)', () => {
    expect(
      CustomerCanSchema.parse({ write: true, readVerification: true, openVerification: true }),
    ).toEqual({
      write: true,
      readVerification: true,
      openVerification: true,
      creditLimit: false,
      owner: false,
      paymentTerms: false,
    });
  });
});

describe('CustomerActingEntitySchema', () => {
  it('names the entity by id and name', () => {
    expect(
      CustomerActingEntitySchema.safeParse({ organizationId: TERM, name: 'Acme' }).success,
    ).toBe(true);
    expect(
      CustomerActingEntitySchema.safeParse({ organizationId: 'x', name: 'Acme' }).success,
    ).toBe(false);
  });
});

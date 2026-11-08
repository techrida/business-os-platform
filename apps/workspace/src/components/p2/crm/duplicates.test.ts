import { describe, expect, it } from 'vitest';

import { duplicatesFrom } from './duplicates';

const CONTACT = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const CUSTOMER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

describe('duplicatesFrom', () => {
  it('reads candidates from a duplicate warning', () => {
    const body = {
      error: {
        code: 'duplicate_found',
        message: 'Possible duplicate',
        correlationId: 'abc',
        duplicates: [
          {
            kind: 'contact',
            id: CONTACT,
            label: 'Sunita Shrestha',
            matchedOn: 'email',
            customerId: CUSTOMER,
          },
        ],
      },
    };
    expect(duplicatesFrom(body)).toEqual([
      { kind: 'contact', id: CONTACT, label: 'Sunita Shrestha', matchedOn: 'email', customerId: CUSTOMER },
    ]);
  });

  it('returns null for any other error body, so a real failure is never shown as a duplicate', () => {
    expect(duplicatesFrom({ error: { code: 'conflict', message: 'x', correlationId: 'y' } })).toBeNull();
    expect(duplicatesFrom('plain text')).toBeNull();
    expect(duplicatesFrom(undefined)).toBeNull();
  });
});

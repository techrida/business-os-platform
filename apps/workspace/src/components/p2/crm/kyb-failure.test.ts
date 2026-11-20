import { describe, expect, it } from 'vitest';

import { kybFailure, missingLabels } from './kyb-failure';

const err = (status: number, code: string, message: string, reason?: string) => ({
  status,
  body: { error: { code, message, correlationId: 'corr-12345678', ...(reason ? { reason } : {}) } },
});

describe('missingLabels', () => {
  it('names the checklist items in words and ignores keys it does not know', () => {
    expect(
      missingLabels(
        'Required documents are missing: registration_certificate, <script>, pan_vat_certificate',
      ),
    ).toEqual(['Company registration certificate', 'PAN or VAT certificate']);
  });

  it('is empty for any other message and for the case with no required item', () => {
    expect(missingLabels('Something else')).toEqual([]);
    expect(missingLabels('Required documents are missing: no_required_item')).toEqual([]);
  });
});

describe('kybFailure', () => {
  it('lists the missing required documents on a submit', () => {
    const f = kybFailure(
      err(409, 'conflict', 'Required documents are missing: authorised_signatory_id'),
      'submit',
    );
    expect(f.message).toBe(
      'These required documents still have no file: Authorised signatory ID. Attach them, then submit.',
    );
    expect(f.reload).toBe(false);
  });

  it('says the case needs a required document when the API names none we know', () => {
    const f = kybFailure(
      err(409, 'conflict', 'Required documents are missing: no_required_item'),
      'submit',
    );
    expect(f.message).toMatch(/at least one required document/);
  });

  it('words a retried submit (case already submitted) and asks for a reload', () => {
    const f = kybFailure(
      err(409, 'conflict', 'A case in status submitted cannot be submitted'),
      'submit',
    );
    expect(f.message).toMatch(/may already have been submitted/);
    expect(f.reload).toBe(true);
  });

  it('shows the infected-file refusal of an attach with the file name, without a reload (TR-Q12e)', () => {
    const f = kybFailure(
      err(
        409,
        'document_infected',
        'A virus was found in “eicar.pdf”. Remove it or upload a clean copy, then try again.',
      ),
      'attach',
    );
    expect(f.message).toBe(
      'A virus was found in “eicar.pdf”. Remove it or upload a clean copy, then try again.',
    );
    expect(f.reload).toBe(false);
  });

  it('words an attach to a frozen case and asks for a reload', () => {
    const f = kybFailure(
      err(409, 'conflict', 'A case in status approved cannot be changed'),
      'attach',
    );
    expect(f.message).toMatch(/no longer be changed/);
    expect(f.reload).toBe(true);
  });

  it('words a stale version and asks for a reload', () => {
    const f = kybFailure(
      err(409, 'conflict', 'This record was changed by someone else; reload it and try again'),
      'attach',
    );
    expect(f.message).toMatch(/Someone else changed this case/);
    expect(f.reload).toBe(true);
  });

  it('does not ask for a reload while the first request with the key is still running', () => {
    const f = kybFailure(
      err(409, 'conflict', 'The first request with this Idempotency-Key did not finish'),
      'submit',
    );
    expect(f.message).toMatch(/still saving/i);
    expect(f.reload).toBe(false);
  });

  it('words the 422 for a document that is not on this case, not as "no response"', () => {
    const f = kybFailure(
      err(422, 'bad_request', 'documentId is not a document of this verification case'),
      'attach',
    );
    expect(f.message).toMatch(/does not belong to this case/);
  });

  it('words a missing customer on open', () => {
    expect(kybFailure(err(404, 'not_found', 'Customer not found'), 'open').message).toMatch(
      /could not find that customer/,
    );
  });

  it('uses the shared sentences for 403 reasons, 5xx and a failed fetch', () => {
    expect(
      kybFailure(err(403, 'forbidden', 'Forbidden', 'out_of_scope'), 'attach').message,
    ).toMatch(/area you cannot access/);
    expect(kybFailure({ status: 503 }, 'submit').message).toMatch(/did not respond/);
    expect(kybFailure(new TypeError('fetch failed'), 'open').message).toMatch(/did not respond/);
  });

  it('never echoes an unknown 409 message', () => {
    const f = kybFailure(err(409, 'conflict', 'secret internal detail'), 'attach');
    expect(f.message).not.toMatch(/secret/);
  });
});

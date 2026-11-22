import { describe, expect, it } from 'vitest';

import { infectedFileMessage } from '@/lib/infected-file';

import { confirmRefusalText } from './confirm-refusal';

const refusal = (status: number, code: string, message = 'refused') => ({
  status,
  body: { error: { code, message, correlationId: 'corr-1' } },
});

describe('confirmRefusalText', () => {
  it('words a file that is not evidence uploaded for the chosen quotation', () => {
    const text = confirmRefusalText(refusal(422, 'invalid_evidence_document'));
    expect(text).toBe(
      'That file is not evidence uploaded for this quotation, or it has not finished uploading. Remove it, upload it again, then confirm. Nothing was confirmed.',
    );
  });

  it('leaves an infected file to the general infected-file words', () => {
    const infected = refusal(409, 'document_infected', 'A virus was found in this file.');
    expect(confirmRefusalText(infected)).toBeUndefined();
    expect(infectedFileMessage(infected)).toBe('A virus was found in this file.');
  });

  it('says a second confirm did not file the named file (409 evidence_not_filed)', () => {
    const text = confirmRefusalText(
      refusal(
        409,
        'evidence_not_filed',
        'This order was already confirmed, so the named files were not filed with it',
      ),
    );
    expect(text).toBe(
      'This order was already confirmed, so your file was not filed with it. Open the order from the sales orders list; you can add evidence when you mark a billing step billable.',
    );
    // Only the 409 carries this meaning.
    expect(confirmRefusalText(refusal(422, 'evidence_not_filed'))).toBeUndefined();
  });

  it('keeps its other refusals and leaves the rest to the general words', () => {
    expect(confirmRefusalText(refusal(422, 'evidence_not_confirmed'))).toMatch(
      /has not been confirmed/,
    );
    expect(confirmRefusalText(refusal(409, 'draft_of_other_revision'))).toMatch(/another revision/);
    expect(confirmRefusalText(refusal(409, 'invalid_evidence_document'))).toBeUndefined();
    expect(confirmRefusalText(refusal(422, 'evidence_policy_unmet'))).toBeUndefined();
    expect(confirmRefusalText(new Error('boom'))).toBeUndefined();
  });
});

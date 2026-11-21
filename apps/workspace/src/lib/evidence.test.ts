import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_REQUIRED,
  INVALID_EVIDENCE,
  evidenceEndpoint,
  evidenceRefusalMessage,
} from './evidence';

const refusal = (status: number, code: string) => ({
  status,
  body: { error: { code, message: 'API words', correlationId: 'c-1' } },
});

describe('evidenceEndpoint', () => {
  it('names the record kind and its id', () => {
    expect(evidenceEndpoint('vendor-bill', 'abc')).toBe('/api/evidence/vendor-bill/abc');
  });
});

describe('evidenceRefusalMessage', () => {
  it('words a file that is not evidence of this record, and a missing file', () => {
    expect(evidenceRefusalMessage(refusal(422, 'invalid_evidence_document'))).toBe(
      INVALID_EVIDENCE,
    );
    expect(evidenceRefusalMessage(refusal(422, 'evidence_required'))).toBe(EVIDENCE_REQUIRED);
    expect(EVIDENCE_REQUIRED).toBe('Upload the document that shows this step was done.');
  });

  it('leaves every other refusal to its caller', () => {
    expect(evidenceRefusalMessage(refusal(422, 'evidence_policy_unmet'))).toBeUndefined();
    expect(evidenceRefusalMessage(refusal(409, 'document_infected'))).toBeUndefined();
    expect(evidenceRefusalMessage(refusal(404, 'invalid_evidence_document'))).toBeUndefined();
    expect(evidenceRefusalMessage({ status: 422, body: 'not json' })).toBeUndefined();
    expect(evidenceRefusalMessage(null)).toBeUndefined();
  });
});

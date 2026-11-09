import { MAX_UPLOAD_BYTES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { MAX_PROOFS, PROOF_ACCEPT, PROOF_MIME, proofProblem } from './proof-rules';

const pdf = { name: 'slip.pdf', type: 'application/pdf', size: 1200 };

describe('proofProblem', () => {
  it('accepts a PDF and the three picture types', () => {
    expect(proofProblem(pdf)).toBeNull();
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(proofProblem({ ...pdf, name: 'slip.img', type })).toBeNull();
    }
  });

  it('offers only those types to the file picker, and up to 10 files', () => {
    expect([...PROOF_MIME].sort()).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    expect(PROOF_ACCEPT).toBe(PROOF_MIME.join(','));
    expect(MAX_PROOFS).toBe(10);
  });

  it('names the file in each refusal', () => {
    expect(proofProblem({ ...pdf, type: 'application/zip' })).toMatch(/slip\.pdf is not a PDF/);
    expect(proofProblem({ ...pdf, size: 0 })).toMatch(/slip\.pdf is empty/);
    expect(proofProblem({ ...pdf, size: MAX_UPLOAD_BYTES + 1 })).toMatch(/larger than 25 MB/);
    expect(proofProblem({ ...pdf, size: MAX_UPLOAD_BYTES })).toBeNull();
  });

  it('refuses a name that is empty or could climb out of a folder', () => {
    for (const name of ['', '   ', '../slip.pdf', 'a/b.pdf', 'a\\b.pdf', 'a\u0000b.pdf']) {
      expect(proofProblem({ ...pdf, name })).toMatch(/no usable name/);
    }
  });
});

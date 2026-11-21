import { describe, expect, it } from 'vitest';

import { generatedPdfState, renderStateOf, type OwnerUpload } from './render-state';

const up = (documentId: string, status: string): OwnerUpload => ({ documentId, status });

describe('generatedPdfState', () => {
  it('is preparing with no document yet, and failed once the render was given up', () => {
    expect(generatedPdfState([], false)).toEqual({ kind: 'preparing' });
    expect(generatedPdfState([], true)).toEqual({ kind: 'failed' });
  });

  it('serves the oldest document with a clean upload', () => {
    expect(
      generatedPdfState([up('a', 'infected'), up('b', 'clean'), up('c', 'clean')], false),
    ).toEqual({ kind: 'clean', documentId: 'b' });
  });

  it('is preparing while a document stores its bytes, even after an earlier give-up', () => {
    expect(generatedPdfState([up('a', 'awaiting_content')], true)).toEqual({ kind: 'preparing' });
    expect(generatedPdfState([up('a', 'quarantined')], false)).toEqual({ kind: 'preparing' });
  });

  it('ignores refused uploads: the render tries again, so it is preparing (or failed when given up)', () => {
    expect(generatedPdfState([up('a', 'rejected')], false)).toEqual({ kind: 'preparing' });
    expect(generatedPdfState([up('a', 'rejected')], true)).toEqual({ kind: 'failed' });
  });

  it('names a file the virus scan refused, apart from a missing one', () => {
    expect(generatedPdfState([up('a', 'infected')], false)).toEqual({ kind: 'scan_refused' });
    expect(generatedPdfState([up('a', 'scan_failed')], false)).toEqual({ kind: 'scan_refused' });
  });
});

describe('renderStateOf', () => {
  it('maps every state to ready, pending or failed', () => {
    expect(renderStateOf({ kind: 'clean', documentId: 'a' })).toBe('ready');
    expect(renderStateOf({ kind: 'preparing' })).toBe('pending');
    expect(renderStateOf({ kind: 'failed' })).toBe('failed');
    expect(renderStateOf({ kind: 'scan_refused' })).toBe('failed');
  });
});

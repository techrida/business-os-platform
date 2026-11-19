import { describe, expect, it } from 'vitest';

import {
  isSameOriginUrl,
  normalizeMime,
  pdfViewerUrl,
  previewFetchOutcome,
  previewKind,
} from './file-preview-model';

const ORIGIN = 'https://app.p1.bos.test';

describe('previewKind', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['Application/PDF; charset=binary', 'pdf'],
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/webp', 'image'],
    ['image/svg+xml', 'unsupported'],
    ['text/html', 'unsupported'],
    ['application/xhtml+xml', 'unsupported'],
    ['application/octet-stream', 'unsupported'],
    ['', 'unsupported'],
  ])('%s is %s', (mime, kind) => {
    expect(previewKind(mime)).toBe(kind);
  });

  it('normalizes the type', () => {
    expect(normalizeMime(' Image/PNG ; x=y')).toBe('image/png');
  });
});

describe('isSameOriginUrl', () => {
  it.each(['/api/documents/1/versions/2/download', '/api/x?a=1#b', `${ORIGIN}/api/x`])(
    'accepts %s',
    (url) => {
      expect(isSameOriginUrl(url, ORIGIN)).toBe(true);
    },
  );

  it.each([
    '//evil.test/x.pdf',
    '/\\evil.test/x.pdf',
    '\\\\evil.test\\x',
    'https://evil.test/x.pdf',
    'http://app.p1.bos.test/x',
    'https://app.p1.bos.test.evil.test/x',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'blob:https://app.p1.bos.test/uuid',
    ' /x',
    '',
  ])('rejects %s', (url) => {
    expect(isSameOriginUrl(url, ORIGIN)).toBe(false);
  });
});

describe('pdfViewerUrl', () => {
  it('adds fit-page hints once', () => {
    expect(pdfViewerUrl('/f.pdf')).toBe('/f.pdf#view=Fit&navpanes=0');
    expect(pdfViewerUrl('/f.pdf#page=2')).toBe('/f.pdf#page=2');
  });
});

describe('previewFetchOutcome', () => {
  it.each([
    [200, 'ready'],
    [409, 'preparing'],
    [425, 'preparing'],
    [424, 'failed'],
    [404, 'unavailable'],
    [410, 'unavailable'],
    [401, 'denied'],
    [403, 'denied'],
    [500, 'error'],
    [400, 'error'],
  ])('maps %i to %s', (status, outcome) => {
    expect(previewFetchOutcome(status)).toBe(outcome);
  });
});

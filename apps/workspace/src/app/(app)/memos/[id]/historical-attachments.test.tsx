import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AttachmentView } from '@/lib/kernel-ui';

import { HistoricalAttachments } from './historical-attachments';

const DOC = '11111111-1111-4111-8111-111111111111';
const VER = '22222222-2222-4222-8222-222222222222';

function file(over: Partial<AttachmentView> = {}): AttachmentView {
  return {
    id: VER,
    documentId: DOC,
    filename: 'scope.pdf',
    sizeBytes: 2048,
    status: 'clean',
    ...over,
  };
}

const render = (files: AttachmentView[]): string =>
  renderToStaticMarkup(<HistoricalAttachments files={files} />);

describe('historical memo attachments', () => {
  it('opens a clean PDF in the viewer and keeps a download link, never a raw download as the main action', () => {
    const html = render([file({ detectedMime: 'application/pdf' })]);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>.*View PDF<\/button>/);
    expect(html).toContain(`href="/api/documents/${DOC}/versions/${VER}/download"`);
    expect(html).not.toContain('/preview"');
    expect(html).not.toMatch(/aria-label="Download /);
  });

  it('says View, not View PDF, for a file that is not a PDF', () => {
    const html = render([file({ filename: 'photo.png', detectedMime: 'image/png' })]);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>.*View<\/button>/);
    expect(html).not.toContain('View PDF');
  });

  it('treats a PDF content type with parameters as a PDF', () => {
    expect(render([file({ detectedMime: 'application/pdf; charset=binary' })])).toContain(
      'View PDF',
    );
  });

  it('offers neither the viewer nor a download for a file that is not clean', () => {
    const html = render([file({ status: 'pending' })]);
    expect(html).toContain('scope.pdf');
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('/download');
    expect(html).not.toContain('View');
  });
});

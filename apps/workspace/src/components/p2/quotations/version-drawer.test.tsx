import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VersionDrawer, type RevisionRow } from './version-drawer';

function row(over: Partial<RevisionRow> = {}): RevisionRow {
  return {
    id: 'v1',
    label: 'Rev 1',
    current: false,
    status: <span>Superseded</span>,
    total: 'NPR 26,90,999.99',
    validUntil: '23 Nov 2026',
    note: null,
    pdf: <span>Not available</span>,
    ...over,
  };
}

const rows: RevisionRow[] = [
  row({
    id: 'v2',
    label: 'Rev 2',
    current: true,
    status: <span>Sent</span>,
    total: 'NPR 1,00,000',
  }),
  row({ id: 'v1', note: 'Customer asked for a smaller scope' }),
];

function render(over: Partial<Parameters<typeof VersionDrawer>[0]> = {}): string {
  return renderToStaticMarkup(<VersionDrawer number="QT-2082-0042" rows={rows} {...over} />);
}

describe('VersionDrawer', () => {
  it('is a native dialog named by its heading, opened by a real button', () => {
    const html = render();
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="([^"]+)"/);
    const id = /<dialog[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>All revisions \(2\)/);
  });

  it('lists every revision, the superseded ones included, with total and status', () => {
    const html = render();
    expect(html).toContain('Rev 1');
    expect(html).toContain('Superseded');
    expect(html).toContain('NPR 26,90,999.99');
    expect(html).toContain('Rev 2');
    expect(html).toContain('NPR 1,00,000');
    expect(html).toContain('Customer asked for a smaller scope');
  });

  it('marks the current revision in words', () => {
    const html = render();
    expect(html.match(/Current/g)).toHaveLength(1);
  });

  it('has a labelled Close button inside the dialog', () => {
    expect(render()).toContain('aria-label="Close"');
  });

  it('shows a plain sentence when there are no revisions to list', () => {
    const html = render({ rows: [] });
    expect(html).toContain('No revisions yet.');
    expect(html).not.toContain('<table');
  });

  it('keeps a very long number in the heading as text', () => {
    const number = 'QT-' + 'X'.repeat(200);
    expect(render({ number })).toContain(number);
  });
});

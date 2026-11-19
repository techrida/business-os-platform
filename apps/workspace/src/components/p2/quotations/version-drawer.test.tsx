import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { VersionDrawer, type RevisionRow } from './version-drawer';

// Open the real dialog and render its portal inline to inspect the contents in the Node renderer.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} defaultOpen />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

function row(over: Partial<RevisionRow> = {}): RevisionRow {
  return {
    id: 'v1',
    label: 'Rev 1',
    href: '/quotations/q1?rev=v1',
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
    href: '/quotations/q1',
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
  it('renders a dialog heading and an accessible trigger', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toMatch(/<h2[^>]*>Revisions of QT-2082-0042<\/h2>/);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>All revisions \(2\)/);
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

  it('links each revision to its page, and the current one to the bare path', () => {
    const html = render();
    expect(html).toMatch(/<a [^>]*href="\/quotations\/q1\?rev=v1"[^>]*>Rev 1<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/quotations\/q1"[^>]*>Rev 2<\/a>/);
  });

  it('marks the current revision in words', () => {
    const html = render();
    expect(html.match(/Current/g)).toHaveLength(1);
  });

  it('has a labelled Close button and a Close action in the fixed footer', () => {
    const html = render();
    expect(html).toContain('aria-label="Close"');
    expect(html).toMatch(/<footer[^>]*><button[^>]*>Close<\/button><\/footer>/);
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

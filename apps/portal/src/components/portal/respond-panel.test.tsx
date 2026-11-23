import { CUSTOMER_VIEW_FORBIDDEN_WORDS } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { sampleView } from './quotation-fixtures';
import { canRespond } from './quotation-status';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { RespondPanel } = await import('./respond-panel');

const IDEM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function render(today: string, over: Parameters<typeof sampleView>[0] = {}) {
  const view = sampleView(over);
  return renderToStaticMarkup(
    <RespondPanel
      quotationId={view.id}
      respondability={canRespond(view, today)}
      acceptKey={IDEM}
      rejectKey={IDEM}
      summary="QT-2082-0042 Rev 2 for USD 3,390.00"
      reloadHref={`/quotations/${view.id}`}
    />,
  );
}

// Inline `style` attributes (the design-system checkbox's hidden form input carries one) are CSS, not words a customer reads.
const words = (html: string) =>
  new Set(
    html
      .replace(/ style="[^"]*"/g, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z]+/)
      .map((w) => w.toLowerCase()),
  );

describe('RespondPanel', () => {
  it('offers accept (name, confirmation) and reject (comment) with the key, and no internal word', () => {
    const html = render('2026-11-10');
    expect(html).toContain('name="acceptedByName"');
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('name="confirm"');
    expect(html).toContain('name="comment"');
    expect(html).toContain(`value="${IDEM}"`);
    expect(html).toContain('Accept quotation');
    expect(html).toContain('Reject quotation');
    const found = words(html);
    expect(CUSTOMER_VIEW_FORBIDDEN_WORDS.filter((w) => found.has(w))).toEqual([]);
  });

  it('when expired, shows Accept disabled and pointing at the reason, and no form', () => {
    const html = render('2026-11-24');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Accept quotation<\/button>/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('expired on 23 Nov 2026');
    expect(html).not.toContain('name="acceptedByName"');
    expect(html).not.toContain('name="comment"');
  });

  it('when already answered, says so and offers nothing to press', () => {
    const html = render('2026-11-10', { status: 'accepted' });
    expect(html).toContain('You have accepted this quotation.');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });
});

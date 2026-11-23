import type { ReactNode } from 'react';
import { PaymentPromiseListSchema, type PaymentPromiseList } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ID } from '../_lib/test-fixtures';

import { PromiseCard } from './promise-card';

// The dialog imports the server action, which imports server-only modules.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
// Radix mounts its portal only when a browser opens it; render the dialog's parts in place.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    trigger,
    title,
    description,
    children,
    footer,
  }: Record<'trigger' | 'title' | 'description' | 'children' | 'footer', ReactNode>) => (
    <>
      {trigger}
      <section>
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
        <footer>{footer}</footer>
      </section>
    </>
  ),
  DialogClose: ({ children }: { children: ReactNode }) => children,
}));

const RECORDER = '55555555-5555-4555-8555-555555555555';
let n = 0;
function item(over: Record<string, unknown>) {
  n += 1;
  return {
    id: `9999999${n}-9999-4999-8999-999999999999`,
    invoiceId: ID,
    promisedDate: '2026-12-01',
    note: null,
    status: 'open',
    recordedByUserId: RECORDER,
    missedAt: null,
    collectionActivityId: null,
    createdAt: '2026-11-20T04:00:00.000Z',
    recordedByName: 'Asha Rai',
    updatedAt: '2026-11-20T04:00:00.000Z',
    ...over,
  };
}

/** The list as `GET .../promises` answers it, newest first, checked against the contract. */
const list = (items: unknown[], can: PaymentPromiseList['can'] = { record: true, reason: null }) =>
  PaymentPromiseListSchema.parse({ items, can });

function render(promises: PaymentPromiseList): string {
  return renderToStaticMarkup(
    <PromiseCard
      invoiceId={ID}
      promises={promises}
      today="2026-11-21"
      dateFormat="dd MMM yyyy"
      reloadHref={`/invoices/${ID}`}
    />,
  );
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('PromiseCard', () => {
  it('shows the open promise with its note and who recorded it, and history with plain labels', () => {
    const html = render(
      list([
        item({ promisedDate: '2026-12-01', note: 'Pays after the harvest sale' }),
        item({ status: 'missed', promisedDate: '2026-11-15', missedAt: '2026-11-16T00:00:00Z' }),
        item({ status: 'replaced', promisedDate: '2026-11-10', recordedByName: null }),
        item({ status: 'kept', promisedDate: '2026-10-01' }),
      ]),
    );
    const text = textOf(html);
    expect(text).toContain('Promised for 01 Dec 2026');
    expect(text).toContain('Pays after the harvest sale');
    expect(text).toContain('Recorded by Asha Rai, 20 Nov 2026');
    expect(text).toMatch(/Missed Promised for 15 Nov 2026/);
    expect(text).toMatch(/Replaced Promised for 10 Nov 2026/);
    expect(text).toMatch(/Kept Promised for 01 Oct 2026/);
    // A recorder without a display name stays unnamed; no ids reach the screen as text.
    expect(text).toContain('Recorded 20 Nov 2026');
    expect(text).not.toContain(RECORDER);
    expect(text).not.toMatch(/9999999\d-/);
  });

  it('says the new promise replaces the open one, and posts the page key and today as the earliest day', () => {
    const html = render(list([item({ promisedDate: '2026-12-01' })]));
    expect(textOf(html)).toContain('This replaces the promise for 01 Dec 2026.');
    expect(html).toMatch(/<button[^>]*>Record promise<\/button>/);
    expect(html).toContain(`name="invoiceId" value="${ID}"`);
    expect(html).toMatch(/name="idempotencyKey" value="[0-9a-f-]{36}"/);
    expect(html).toContain('name="promisedDate"');
    expect(html).toContain('name="note"');
  });

  it('describes a first promise without replace wording when none is open', () => {
    const text = textOf(render(list([item({ status: 'missed', promisedDate: '2026-11-15' })])));
    expect(text).toContain('No open promise to pay.');
    expect(text).not.toContain('This replaces');
    expect(text).toContain('a collection call is planned');
  });

  it("shows Record promise off with the API's reason, and no dialog, when the invoice is not open", () => {
    const html = render(list([], { record: false, reason: 'invoice_not_open' }));
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Record promise<\/button>/);
    // The reason lives in the Tooltip (UIP-FORM-011), not as text under the button.
    expect(textOf(html)).not.toContain('Nothing is owed on this invoice');
    expect(html).not.toContain('name="promisedDate"');
  });

  it('keeps the permission reason out of the page text (it is the Tooltip)', () => {
    const text = textOf(render(list([], { record: false, reason: 'no_permission' })));
    expect(text).not.toContain('Your roles do not include recording promises to pay.');
  });
});

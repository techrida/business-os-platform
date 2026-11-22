import { useActionState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ID } from '../_lib/test-fixtures';

import { IssueDialog, SubmitDialog } from './action-forms';

// The dialogs import the server actions, which import server-only modules.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
// The done state is what the server action returns; hand it to the dialog directly.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useActionState: vi.fn(actual.useActionState) };
});
// Radix mounts its portal only when a browser opens it; draw the body and the footer apart.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    title,
    description,
    children,
    footer,
  }: Record<'title' | 'description' | 'children' | 'footer', ReactNode>) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      <div data-body="">{children}</div>
      <footer>{footer}</footer>
    </section>
  ),
  DialogClose: ({ children }: { children: ReactNode }) => children,
}));

const props = {
  invoiceId: ID,
  version: 3,
  name: 'Debit note',
  idempotencyKey: 'key-0001',
  reloadHref: `/invoices/${ID}`,
};

/** The dialog after the API accepted the action, as the server action reports it. */
function renderDone(dialog: ReactNode, message: string): string {
  vi.mocked(useActionState).mockReturnValue([
    { key: 'key-0002', done: true, message },
    vi.fn(),
    false,
  ]);
  return renderToStaticMarkup(dialog);
}

/** The dialog body's text, without the footer's Done button. */
const body = (html: string): string =>
  (/<div data-body="">([\s\S]*)<\/div><footer>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, ' ');

afterEach(() => {
  vi.mocked(useActionState).mockReset();
});

describe('a done invoice action', () => {
  it('says what Submit for approval did and the new status, not an empty body', () => {
    const html = renderDone(<SubmitDialog {...props} />, 'Submitted for approval.');
    const text = body(html);
    expect(text).toContain('Submitted for approval.');
    expect(text).toContain('awaiting approval');
    expect(text).toContain('Done closes this');
    expect(html).toContain('>Done</button>');
    // The form and its confirm button are gone once the action is done.
    expect(html).not.toContain('<form');
  });

  it('says what Issue did, with the number the platform set', () => {
    const html = renderDone(
      <IssueDialog {...props} kindLabel="Debit note" />,
      'Issued as DN-2083/84-00012.',
    );
    const text = body(html);
    expect(text).toContain('Issued as DN-2083/84-00012.');
    expect(text).toContain('cannot be changed');
    expect(html).not.toContain('<form');
  });
});

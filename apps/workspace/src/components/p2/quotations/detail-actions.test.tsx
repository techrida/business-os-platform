import type {
  QuotationCapabilities,
  QuotationContact,
  QuotationStatus,
  QuotationVersionDto,
} from '@bos/contracts';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DetailActions } from './detail-actions';

// The dialogs import the server actions, which import server-only modules.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

// Open the real dialog and render its portal inline to inspect the contents in the Node renderer.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} defaultOpen />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

const Q = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const ADA = '44444444-4444-4444-8444-444444444441';
const BOB = '44444444-4444-4444-8444-444444444442';
const TODAY = '2026-11-08';

const contacts: QuotationContact[] = [
  { id: ADA, name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: BOB, name: 'Bob NoMail', email: null },
];

function current(over: Partial<QuotationVersionDto> = {}): QuotationVersionDto {
  return {
    id: V,
    version: 7,
    status: 'approved',
    renderedScanStatus: 'clean',
    validUntil: '2026-11-23',
    contactId: ADA,
    ...over,
  } as QuotationVersionDto;
}

/** The server's answer for an owner who may edit and revise; each test narrows it where it matters. */
const ALLOWED: QuotationCapabilities = { canEdit: true, canRevise: true };

function render(
  over: Partial<QuotationVersionDto> = {},
  list: QuotationContact[] = contacts,
  capabilities: QuotationCapabilities = ALLOWED,
): string {
  return renderToStaticMarkup(
    <DetailActions
      quotationId={Q}
      number="QT-2082-0042"
      current={current(over)}
      contacts={list}
      capabilities={capabilities}
      reloadHref={`/quotations/${Q}`}
      today={TODAY}
    />,
  );
}

const triggers = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(Send to customer|Record outcome|Revise)<\/button>/g)].map(
    (m) => m[1] ?? '',
  );

describe('which actions a status offers', () => {
  const cases: [QuotationStatus, string[]][] = [
    ['draft', []],
    ['submitted', []],
    ['returned', []],
    ['approved', ['Send to customer', 'Revise']],
    ['sent', ['Record outcome', 'Revise']],
    ['accepted', []],
    ['rejected', ['Revise']],
    ['expired', ['Send to customer', 'Revise']],
    ['cancelled', []],
    ['superseded', []],
  ];
  it.each(cases)('%s offers %j', (status, expected) => {
    const html = render({ status, rejectionSource: status === 'rejected' ? 'customer' : null });
    // The trigger button is the first button of each dialog with that label.
    expect([...new Set(triggers(html))]).toEqual(expected);
  });

  it('renders nothing at all when no action applies, so the slot stays empty', () => {
    expect(render({ status: 'accepted' })).toBe('');
  });
});

describe('Edit (demo feedback: a Returned quotation had no way back into the editor)', () => {
  const editLink = (html: string) =>
    /<a[^>]*href="([^"]*)"[^>]*aria-label="Edit QT-2082-0042"[^>]*>Edit<\/a>/.exec(html)?.[1];

  it.each(['draft', 'returned'] as const)(
    'links a %s quotation the caller may edit to its editor',
    (status) => {
      expect(editLink(render({ status }))).toBe(`/quotations/${Q}/edit`);
    },
  );

  it('is not offered when the server says the caller may not edit', () => {
    expect(render({ status: 'returned' }, contacts, { canEdit: false, canRevise: false })).toBe('');
  });

  it.each(['submitted', 'approved', 'sent', 'rejected', 'accepted'] as const)(
    'is not offered for a %s quotation, whatever the capability says',
    (status) => {
      const html = render({ status, rejectionSource: status === 'rejected' ? 'customer' : null });
      expect(editLink(html)).toBeUndefined();
    },
  );
});

describe('Revise follows the server capability (demo feedback: Revise answered 403)', () => {
  it.each(['approved', 'sent', 'rejected', 'expired'] as const)(
    'hides Revise on a %s quotation the caller may not revise',
    (status) => {
      const html = render(
        { status, rejectionSource: status === 'rejected' ? 'customer' : null },
        contacts,
        { canEdit: false, canRevise: false },
      );
      expect(triggers(html)).not.toContain('Revise');
      expect(html).not.toContain('Why are you revising it?');
    },
  );

  it('still hides Revise on a draft even if the capability were true', () => {
    expect(triggers(render({ status: 'draft' }))).not.toContain('Revise');
  });
});

it.each([
  ['approved', 'Send to customer'],
  ['sent', 'Record outcome'],
  ['rejected', 'Start revision'],
] as const)('links the %s action footer to the matching form', (status, label) => {
  const html = render({ status, rejectionSource: status === 'rejected' ? 'customer' : null });
  const footers = [...html.matchAll(/<footer[^>]*>(.*?)<\/footer>/g)].map((match) => match[1]);
  const footer = footers.find((content) => content?.includes(`>${label}</button>`));
  const formId = /<button[^>]*type="submit"[^>]*form="([^"]+)"/.exec(footer ?? '')?.[1];
  expect(formId).toBeTruthy();
  const form = [...html.matchAll(/<form[^>]*>.*?<\/form>/g)].find((match) =>
    match[0].includes(`id="${formId}"`),
  )?.[0];
  expect(form).toContain(`name="quotationId" value="${Q}"`);
  expect(form).toContain(`name="versionId" value="${V}"`);
  expect(form).toContain('name="expectedVersion" value="7"');
  expect(form).not.toContain(`>${label}</button>`);
});

describe('Send', () => {
  it('opens a dialog that says the customer gets a portal link, never a file', () => {
    const html = render();
    expect(html).toContain('link to their portal');
    expect(html).toContain('never attached and never sent as a file');
    expect(html).not.toContain('aria-disabled');
  });

  it('preselects the version contact and disables contacts without an email', () => {
    const html = render();
    expect(html).toMatch(
      new RegExp(`<option value="${ADA}" selected="">Ada Lovelace \\(ada@example.com\\)`),
    );
    expect(html).toMatch(
      new RegExp(`<option value="${BOB}" disabled="">Bob NoMail \\(no email address\\)`),
    );
  });

  it('does not preselect a version contact that has no email', () => {
    const html = render({ contactId: BOB });
    expect(html).toContain('<option value="" selected="">Choose a contact</option>');
    expect(html.match(/selected=""/g)).toHaveLength(1);
  });

  it('sends the version row version, not the quotation one, and its own idempotency key', () => {
    const html = render();
    expect(html).toContain('name="expectedVersion" value="7"');
    expect(html).toContain(`name="versionId" value="${V}"`);
    const keys = [...html.matchAll(/name="idempotencyKey" value="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBe(2);
    expect(new Set(keys).size).toBe(2);
  });

  it.each([
    ['a file not yet clean', { renderedScanStatus: 'quarantined' as const }, /still being scanned/],
    ['a past validity date', { validUntil: '2026-11-07' }, /has expired/],
    ['the expired status', { status: 'expired' as const }, /has expired/],
  ])('is off for %s, with the reason linked by aria-describedby', (_name, over, words) => {
    const html = render(over);
    const described = /<button[^>]*aria-describedby="([^"]+)"[^>]*>Send to customer/.exec(html);
    expect(described?.[1]).toBeTruthy();
    expect(html).toMatch(new RegExp(`aria-disabled="true"`));
    const reason = new RegExp(`<p id="${described?.[1]}"[^>]*>([^<]+)</p>`).exec(html);
    expect(reason?.[1]).toMatch(words);
    // Off means no form to submit: the dialog and its fields are not in the page.
    expect(html).not.toContain('name="recipientContactId"');
  });

  it('is off, with one line of words, when no contact has an email', () => {
    const html = render({}, [{ id: BOB, name: 'Bob NoMail', email: null }]);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('No contact for this customer has an email address');
  });

  it('keeps a very long contact name as text', () => {
    const name = 'N'.repeat(300);
    expect(render({}, [{ id: ADA, name, email: 'a@example.com' }])).toContain(name);
  });
});

describe('Record outcome', () => {
  const html = () => render({ status: 'sent' });

  it('asks for the answer, the date (today, no later), evidence and a comment', () => {
    const out = html();
    expect(out).toContain('What did the customer say?');
    expect(out).toMatch(/type="radio" name="outcome" value="accepted"/);
    expect(out).toMatch(/type="radio" name="outcome" value="rejected"/);
    expect(out).toMatch(/type="date"[^>]*name="decidedOn"[^>]*/);
    expect(out).toContain(`value="${TODAY}"`);
    expect(out).toContain(`max="${TODAY}"`);
    for (const kind of ['signed_quote', 'purchase_order', 'contract']) {
      expect(out).toContain(`type="checkbox" name="evidenceKinds" value="${kind}"`);
    }
    expect(out).toContain('Required to record an accepted quotation.');
    expect(out).toContain('Required when the customer rejected.');
  });

  it('sends the version row version', () => {
    expect(html()).toContain('name="expectedVersion" value="7"');
  });
});

describe('Revise', () => {
  it('needs a reason and says what happens to the current revision', () => {
    const out = render({ status: 'sent' });
    expect(out).toContain('Why are you revising it?');
    expect(out).toContain('marks the current one Superseded');
  });

  it('does not claim a rejected revision becomes Superseded', () => {
    const out = render({ status: 'rejected', rejectionSource: 'customer' });
    expect(out).not.toContain('Superseded');
    expect(out).toContain('The current one stays in the revision list as a record.');
  });
});

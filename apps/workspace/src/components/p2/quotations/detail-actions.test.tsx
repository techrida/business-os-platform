// @vitest-environment jsdom
import type {
  QuotationCapabilities,
  QuotationContact,
  QuotationStatus,
  QuotationVersionDto,
} from '@bos/contracts';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';
import { DetailActions } from './detail-actions';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  document.body.innerHTML = '';
});

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
    renderFailed: false,
    validUntil: '2026-11-23',
    contactId: ADA,
    ...over,
  } as QuotationVersionDto;
}

/** The server's answer for an owner who may edit, send, record outcome, and revise; each test narrows it where it matters. */
const ALLOWED: QuotationCapabilities = {
  canEdit: true,
  canRevise: true,
  canSend: true,
  canRecordOutcome: true,
};

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

async function mountSend(over: Partial<QuotationVersionDto> = {}) {
  return mountForm(
    <DetailActions
      quotationId={Q}
      number="QT-2082-0042"
      current={current(over)}
      contacts={contacts}
      capabilities={ALLOWED}
      reloadHref={`/quotations/${Q}`}
      today={TODAY}
    />,
  );
}

/** Types in the Send-to box (it searches as you type) and returns the rows it lists. */
async function searchContacts(container: HTMLElement, text: string): Promise<HTMLElement[]> {
  const field = container.querySelector('input[name="recipientContactId"]');
  await fill(field?.parentElement?.querySelector('input[role="combobox"]') ?? null, text);
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
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

describe('Send and Record outcome respect server capabilities and live fallbacks', () => {
  it('hides Send to customer when capabilities.canSend is false', () => {
    const html = render({ status: 'approved' }, contacts, {
      canEdit: false,
      canRevise: true,
      canSend: false,
    });
    expect(triggers(html)).toEqual(['Revise']);
  });

  it('hides Record outcome when capabilities.canRecordOutcome is false', () => {
    const html = render({ status: 'sent' }, contacts, {
      canEdit: false,
      canRevise: true,
      canRecordOutcome: false,
    });
    expect(triggers(html)).toEqual(['Revise']);
  });

  it('uses maySend and mayRecordOutcome when capabilities omit the flags', () => {
    const noSend = renderToStaticMarkup(
      <DetailActions
        quotationId={Q}
        number="QT-2082-0042"
        current={current({ status: 'approved' })}
        contacts={contacts}
        capabilities={{ canEdit: false, canRevise: false }}
        reloadHref={`/quotations/${Q}`}
        today={TODAY}
        maySend={false}
      />,
    );
    expect(noSend).toBe('');

    const noOutcome = renderToStaticMarkup(
      <DetailActions
        quotationId={Q}
        number="QT-2082-0042"
        current={current({ status: 'sent' })}
        contacts={contacts}
        capabilities={{ canEdit: false, canRevise: false }}
        reloadHref={`/quotations/${Q}`}
        today={TODAY}
        mayRecordOutcome={false}
      />,
    );
    expect(noOutcome).toBe('');

    const omitted = renderToStaticMarkup(
      <DetailActions
        quotationId={Q}
        number="QT-2082-0042"
        current={current({ status: 'approved' })}
        contacts={contacts}
        capabilities={{ canEdit: false, canRevise: false }}
        reloadHref={`/quotations/${Q}`}
        today={TODAY}
      />,
    );
    expect(omitted).toBe('');
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

  it('preselects the version contact and disables contacts without an email', async () => {
    const html = render();
    expect(html).toMatch(
      new RegExp(`<input type="hidden" name="recipientContactId" value="${ADA}"`),
    );
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
    // The list can only be searched on a mounted page: Bob is listed but cannot be picked.
    const { container, unmount } = await mountSend();
    try {
      // One box that filters as you type (no Search button); a row shows the email the search matched on.
      expect(
        Array.from(container.querySelectorAll('button')).some((b) =>
          /search/i.test(b.textContent ?? ''),
        ),
      ).toBe(false);
      const options = await searchContacts(container, 'a');
      expect(options.map((o) => o.textContent?.trim())).toEqual([
        'Ada Lovelaceada@example.com',
        'Bob NoMailNo email address',
      ]);
      expect(options[0]!.getAttribute('aria-disabled')).toBeNull();
      expect(options[1]!.getAttribute('aria-disabled')).toBe('true');
      const byEmail = await searchContacts(container, 'ada@ex');
      expect(byEmail.map((o) => o.textContent?.trim())).toEqual(['Ada Lovelaceada@example.com']);
    } finally {
      await unmount();
    }
  });

  it('does not preselect a version contact that has no email', async () => {
    const { container, unmount } = await mountSend({ contactId: BOB });
    try {
      const field = container.querySelector<HTMLInputElement>('input[name="recipientContactId"]')!;
      // The empty value is submitted and the box is blank, not Bob or Ada.
      expect(field.value).toBe('');
      expect(
        field.parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!.value,
      ).toBe('');
    } finally {
      await unmount();
    }
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
  ])('is off for %s, with no caption beside it', (_name, over, words) => {
    const html = render(over);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Send to customer<\/button>/);
    // UIP-FORM-011: the reason is the Tooltip's (blocked-action-tooltips.test.tsx), not a caption.
    expect(html).not.toMatch(words);
    // Off means no form to submit: the dialog and its fields are not in the page.
    expect(html).not.toContain('name="recipientContactId"');
  });

  it('is off, with one line of words, when no contact has an email', () => {
    const html = render({}, [{ id: BOB, name: 'Bob NoMail', email: null }]);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('No contact for this customer has an email address');
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
    expect(out).toMatch(/role="radio"[^>]*value="accepted"/);
    expect(out).toMatch(/role="radio"[^>]*value="rejected"/);
    // The shared date picker (React Aria) takes `max` as its maxValue, so later days are blocked in
    // its calendar rather than by a native `max` attribute; the server refuses a future date too
    // (forms.test.ts).
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Calendar"');
    expect(out).toContain(`name="decidedOn" value="${TODAY}"`);
    for (const kind of ['signed_quote', 'purchase_order', 'contract']) {
      expect(out).toMatch(new RegExp(`role="checkbox"[^>]*value="${kind}"`));
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

const V_EARLIER = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('Cancel quotation (F1-Q27: Cancel only)', () => {
  const cancelTriggers = (html: string): number =>
    [...html.matchAll(/<button[^>]*>Cancel quotation<\/button>/g)].length;

  function renderWith(
    status: QuotationStatus,
    capabilities: QuotationCapabilities,
    lifecycle?: { canCancel?: boolean },
  ): string {
    return renderToStaticMarkup(
      <DetailActions
        quotationId={Q}
        number="QT-2082-0042"
        current={current({ status, rejectionSource: status === 'rejected' ? 'customer' : null })}
        contacts={contacts}
        capabilities={{ ...capabilities, ...lifecycle }}
        reloadHref={`/quotations/${Q}`}
        today={TODAY}
      />,
    );
  }

  it.each(['draft', 'returned', 'submitted'] as const)(
    'is offered on a %s quotation the API says the caller may cancel',
    (s) => {
      const html = renderWith(s, ALLOWED, { canCancel: true });
      expect(cancelTriggers(html)).toBeGreaterThan(0);
      expect(html).toContain('Why are you cancelling it?');
    },
  );

  it('says a Submitted quotation leaves the approver too', () => {
    expect(renderWith('submitted', ALLOWED, { canCancel: true })).toContain(
      'Cancelling ends this quotation and its approval request',
    );
    expect(renderWith('draft', ALLOWED, { canCancel: true })).not.toContain('approval request');
  });

  it('tells the person that cancelling a revision gives the earlier sent or approved one back (R6D)', () => {
    const html = renderToStaticMarkup(
      <DetailActions
        quotationId={Q}
        number="QT-2082-0042"
        current={{ ...current({ status: 'draft' }), supersedesVersionId: V_EARLIER }}
        contacts={contacts}
        capabilities={{ ...ALLOWED, canCancel: true }}
        reloadHref={`/quotations/${Q}`}
        today={TODAY}
      />,
    );
    expect(html).toContain('becomes the live quotation again');
    expect(html).toContain('>Discard revision</button>');
    expect(html).not.toContain('>Cancel quotation</button>');
    expect(html).not.toContain('it stays in the list as Cancelled');
    expect(renderWith('draft', ALLOWED, { canCancel: true })).not.toContain('live quotation again');
  });

  it.each(['approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled'] as const)(
    'is not offered on a %s quotation, which the API cannot cancel',
    (s) => {
      expect(cancelTriggers(renderWith(s, ALLOWED, { canCancel: true }))).toBe(0);
    },
  );

  it('follows the API answer, not the edit right', () => {
    expect(cancelTriggers(renderWith('draft', ALLOWED, { canCancel: false }))).toBe(0);
    expect(
      cancelTriggers(renderWith('draft', { ...ALLOWED, canEdit: false }, { canCancel: true })),
    ).toBeGreaterThan(0);
  });

  it('is not offered when the API answer has no canCancel at all', () => {
    expect(cancelTriggers(renderWith('draft', ALLOWED))).toBe(0);
    expect(cancelTriggers(renderWith('submitted', ALLOWED))).toBe(0);
  });
});

describe('Record outcome names the revision', () => {
  it('titles the dialog with the current revision it records on', () => {
    const html = render({ status: 'sent', revisionNo: 2 });
    expect(html).toContain('Record outcome for revision 2');
    expect(html).toContain('QT-2082-0042, revision 2');
    expect(html).not.toContain('Record the outcome of');
  });
});

// The customer page's Commercial terms card, per role: each field shows its own Change control only when the API's
// `can` flag for it is true (never a control the API would refuse); no limit and a 0.00 limit read differently; the
// terms are the acting entity's, named; and a list that did not load says so instead of offering a broken edit.
import type { CustomerCan, PartyAccountDto } from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS } from '@bos/locale';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { money } from '@/lib/kernel-format';

vi.mock('server-only', () => ({}));
vi.mock('./terms-actions', () => ({
  changeOwnerAction: vi.fn(),
  setCreditLimitAction: vi.fn(),
  setPaymentTermAction: vi.fn(),
}));

const { CommercialTerms } = await import('./commercial-terms');
type Props = Parameters<typeof CommercialTerms>[0];

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ENTITY = '33333333-3333-4333-8333-333333333333';
const OTHER_ENTITY = '44444444-4444-4444-8444-444444444444';
const NET30 = '55555555-5555-4555-8555-555555555555';

const NONE: CustomerCan = {
  write: false,
  readVerification: false,
  openVerification: false,
  creditLimit: false,
  owner: false,
  paymentTerms: false,
};
const ROLES: Record<string, Partial<CustomerCan>> = {
  founder: { write: true, creditLimit: true, owner: true, paymentTerms: true },
  sales: { write: true, paymentTerms: true },
  finance: { creditLimit: true },
  management: { owner: true },
  reader: {},
};

const account = (over: Partial<PartyAccountDto> = {}): PartyAccountDto => ({
  partyId: CUSTOMER,
  organizationId: ENTITY,
  organizationName: 'Techrida Nepal Pvt. Ltd.',
  paymentTermId: NET30,
  creditLimit: '100000.00',
  version: 2,
  ...over,
});

const props = (over: Partial<Props> = {}): Props => ({
  customerId: CUSTOMER,
  customerVersion: 4,
  merged: false,
  can: NONE,
  owner: { userId: OWNER, name: 'Sita Rai' },
  actingEntity: { organizationId: ENTITY, name: 'Techrida Nepal Pvt. Ltd.' },
  accounts: [account()],
  paymentTerms: { status: 'fulfilled', value: [{ id: NET30, label: 'Net 30 days' }] },
  owners: null,
  portal: {
    access: { hasUser: false, canInvite: false, blocked: null },
    ownerLabel: 'Sita Rai',
    invite: null,
    noContact: false,
  },
  numberSystems: DEFAULT_NUMBER_SYSTEMS,
  ...over,
});

function render(p: Props): string {
  return renderToStaticMarkup(<CommercialTerms {...p} />)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const as = (role: keyof typeof ROLES, over: Partial<Props> = {}): Props =>
  props({
    can: { ...NONE, ...ROLES[role] },
    owners:
      ROLES[role]?.owner === true
        ? { status: 'fulfilled', value: [{ userId: OWNER, displayName: 'Sita Rai' }] }
        : null,
    ...over,
  });

const changes = (text: string) =>
  ['account owner', 'payment terms', 'credit limit'].filter((f) => text.includes(`Change ${f}`));

describe('who may change what', () => {
  it.each([
    ['founder', ['account owner', 'payment terms', 'credit limit']],
    ['sales', ['payment terms']],
    ['finance', ['credit limit']],
    ['management', ['account owner']],
    ['reader', []],
  ] as const)('offers %s exactly %j', (role, expected) => {
    expect(changes(render(as(role)))).toEqual(expected);
  });

  it('shows the values read-only to everyone', () => {
    const text = render(as('reader'));
    expect(text).toContain('Sita Rai');
    expect(text).toContain('Net 30 days');
    expect(text).toContain(money('100000.00', 'NPR', DEFAULT_NUMBER_SYSTEMS));
  });

  it('offers nothing on a merged record', () => {
    expect(changes(render(as('founder', { merged: true })))).toEqual([]);
  });

  it('offers no owner change when the people list did not load, and says why', () => {
    const text = render(as('founder', { owners: { status: 'rejected', reason: new Error('x') } }));
    expect(changes(text)).toEqual(['payment terms', 'credit limit']);
    expect(text).toContain('The list of people did not load');
  });

  it('offers no payment-term change when the terms list did not load, and says why', () => {
    const text = render(
      as('sales', { paymentTerms: { status: 'rejected', reason: new Error('x') } }),
    );
    expect(changes(text)).toEqual([]);
    expect(text).toContain('The list of payment terms did not load');
    expect(text).toContain('Payment terms unavailable');
  });
});

describe('the credit limit', () => {
  it('reads no limit differently from a zero limit', () => {
    const none = render(as('reader', { accounts: [account({ creditLimit: null })] }));
    expect(none).toContain('No limit set');
    expect(none).toContain('Orders are never held for credit.');
    expect(none).not.toContain(money('0.00', 'NPR', DEFAULT_NUMBER_SYSTEMS));

    const zero = render(as('reader', { accounts: [account({ creditLimit: '0.00' })] }));
    expect(zero).toContain(money('0.00', 'NPR', DEFAULT_NUMBER_SYSTEMS));
    expect(zero).toContain('A zero limit holds every order');
    expect(zero).not.toContain('No limit set');
  });

  it('says what the limit does', () => {
    expect(render(as('reader'))).toContain(
      'the open receivables plus that order are compared with this limit',
    );
  });

  it("is the acting entity's, named; another entity's terms do not count here", () => {
    const text = render(
      as('finance', {
        accounts: [account({ organizationId: OTHER_ENTITY, creditLimit: '5.00' })],
      }),
    );
    expect(text).toContain('agreed with Techrida Nepal Pvt. Ltd.');
    expect(text).toContain('No limit set');
    expect(text).not.toContain(money('5.00', 'NPR', DEFAULT_NUMBER_SYSTEMS));
    // No terms row yet: the first save is still offered.
    expect(changes(text)).toEqual(['credit limit']);
  });

  it('is unavailable, and not editable, when the API did not say which entity', () => {
    const text = render(as('founder', { actingEntity: undefined }));
    expect(text).toContain('Unavailable');
    expect(text).toContain('The terms did not load');
    expect(changes(text)).toEqual(['account owner']);
  });
});

describe('the owner', () => {
  it('says Not assigned for a customer without one', () => {
    expect(render(as('reader', { owner: { userId: null, name: null } }))).toContain('Not assigned');
  });
});

describe('portal access', () => {
  const portal = (over: Partial<Props['portal']>): Partial<Props> => ({
    portal: { ...props().portal, ...over },
  });

  it('shows the state to a reader, with no invite', () => {
    expect(
      render(as('reader', portal({ access: { hasUser: true, canInvite: false, blocked: null } }))),
    ).toContain('Active');
    expect(render(as('reader'))).toContain('Not invited');
  });

  it('says KYB comes first, and who invites the first admin', () => {
    expect(
      render(
        as(
          'sales',
          portal({ access: { hasUser: false, canInvite: false, blocked: 'kyb_not_verified' } }),
        ),
      ),
    ).toContain("Portal access opens once this customer's KYB verification is approved.");
    expect(
      render(
        as(
          'sales',
          portal({ access: { hasUser: false, canInvite: false, blocked: 'owner_only' } }),
        ),
      ),
    ).toContain('The account owner, Sita Rai, invites the first portal admin.');
  });

  it('shows the invite control it is given, or asks for a contact first', () => {
    const access = { hasUser: false, canInvite: true, blocked: null };
    expect(
      render(
        as('sales', portal({ access, invite: <button type="button">Invite portal admin</button> })),
      ),
    ).toContain('Invite portal admin');
    expect(render(as('sales', portal({ access, noContact: true })))).toContain(
      'Add a contact with an email first',
    );
  });
});

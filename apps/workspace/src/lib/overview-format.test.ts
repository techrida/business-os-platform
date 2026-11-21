import { describe, expect, it } from 'vitest';

import {
  activityHeadline,
  activityHref,
  firstName,
  greetingFor,
  notificationText,
  openLeadCount,
  quickActions,
} from './overview-format';

describe('greetingFor', () => {
  it('greets by the hour in Kathmandu, not the server clock', () => {
    // 04:00Z is 09:45 in Kathmandu; 08:00Z is 13:45; 14:00Z is 19:45; 18:15Z is midnight.
    expect(greetingFor(new Date('2026-11-19T04:00:00Z'), 'Amanda Vance')).toBe(
      'Good morning, Amanda',
    );
    expect(greetingFor(new Date('2026-11-19T08:00:00Z'), 'Amanda Vance')).toBe(
      'Good afternoon, Amanda',
    );
    expect(greetingFor(new Date('2026-11-19T14:00:00Z'), 'Amanda Vance')).toBe(
      'Good evening, Amanda',
    );
    expect(greetingFor(new Date('2026-11-19T18:15:00Z'), 'Amanda Vance')).toBe(
      'Good morning, Amanda',
    );
  });

  it('keeps Welcome back when no real name is known', () => {
    const now = new Date('2026-11-19T04:00:00Z');
    expect(greetingFor(now, undefined)).toBe('Welcome back');
    expect(greetingFor(now, '   ')).toBe('Welcome back');
    // The directory falls back to the email address for an unnamed user.
    expect(greetingFor(now, 'amanda@example.test')).toBe('Welcome back');
  });

  it('takes the first word as the first name', () => {
    expect(firstName('  Mina  Rai ')).toBe('Mina');
    expect(firstName(null)).toBeNull();
  });
});

describe('notificationText', () => {
  it('turns the producer reference for an unnumbered document into words', () => {
    expect(notificationText('Draft tax_invoice 242d0b45 was approved')).toBe(
      'Tax invoice draft was approved',
    );
    expect(notificationText('Draft tax_invoice 242d0b45 was approved.')).toBe(
      'Tax invoice draft was approved.',
    );
    expect(notificationText('Draft quotation_version 0a1b2c3d was returned')).toBe(
      'Quotation draft was returned',
    );
  });

  it('humanizes a document type it has no label for, and lowers it inside a sentence', () => {
    expect(notificationText('Draft goods_receipt abcdef12 was approved')).toBe(
      'Goods receipt draft was approved',
    );
    expect(notificationText('Your Draft memo 1234abcd needs review')).toBe(
      'Your memo draft needs review',
    );
  });

  it('leaves real document numbers alone and drops whole ids', () => {
    expect(notificationText('INV-2082-0001 was approved')).toBe('INV-2082-0001 was approved');
    expect(notificationText('Request 11111111-1111-4111-8111-111111111111 was approved')).toBe(
      'Request was approved',
    );
  });
});

describe('open counts', () => {
  it('counts new, contacted and qualified leads only', () => {
    expect(
      openLeadCount({ new: 2, contacted: 3, qualified: 1, converted: 5, lost: 4, on_hold: 6 }),
    ).toBe(6);
  });
});

describe('quickActions', () => {
  const only = (...granted: string[]) => {
    const set = new Set(granted);
    return (permission: string) => set.has(permission);
  };

  it('renders no tile the caller cannot use', () => {
    expect(quickActions(only())).toEqual([]);
    expect(quickActions(only('crm.lead.write')).map((t) => t.label)).toEqual(['New lead']);
  });

  it('links each tile to an existing page', () => {
    const tiles = quickActions(
      only(
        'crm.lead.write',
        'customer.write',
        'quotation.draft',
        'memo.read',
        'admin.users.invite',
      ),
    );
    expect(tiles.map((t) => [t.label, t.href])).toEqual([
      ['New lead', '/leads/new'],
      ['New customer', '/customers/new'],
      ['Quotation', '/opportunities'],
      ['Memos', '/memos'],
      ['Add user', '/settings/users/new'],
    ]);
  });
});

describe('activity wording', () => {
  it('says who did what only when the name is known', () => {
    expect(activityHeadline('call', 'Amanda Vance')).toBe('Amanda Vance logged a call');
    expect(activityHeadline('note', 'Amanda Vance')).toBe('Amanda Vance added a note');
    expect(activityHeadline('call', undefined)).toBe('Call logged');
    // Server-written kinds have no person's verb.
    expect(activityHeadline('stage_change', 'Amanda Vance')).toBe('Stage changed');
    // A completed collection call has its own words, not the catch-all "Activity".
    expect(activityHeadline('collection_call', 'Amanda Vance')).toBe(
      'Amanda Vance completed a collection call',
    );
    expect(activityHeadline('collection_call', undefined)).toBe('Collection call completed');
    expect(activityHeadline('mystery', undefined)).toBe('Activity');
  });

  it('links to the record the activity belongs to', () => {
    const none = { leadId: null, opportunityId: null, customerId: null, quotationId: null };
    expect(activityHref({ ...none, leadId: 'l1' })).toBe('/leads/l1');
    expect(activityHref({ ...none, opportunityId: 'o1', customerId: 'c1' })).toBe(
      '/opportunities/o1',
    );
    expect(activityHref(none)).toBeNull();
  });
});

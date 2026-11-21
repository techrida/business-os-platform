import type { ActivityDto } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { followUpActionsFor } from './follow-up-subject';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

type Item = Parameters<typeof followUpActionsFor>[0];
const none: Pick<
  ActivityDto,
  'leadId' | 'opportunityId' | 'customerId' | 'contactId' | 'quotationId'
> = { leadId: null, opportunityId: null, customerId: null, contactId: null, quotationId: null };
const on = (kind: keyof typeof none, assigneeUserId: string | null): Item => ({
  ...none,
  [kind]: ID,
  assigneeUserId,
});
const holding =
  (...held: string[]) =>
  (permission: string) =>
    held.includes(permission);

describe('followUpActionsFor (the /activities actions, U20a2-Q7)', () => {
  it("gives every action to whoever holds the subject's write", () => {
    expect(followUpActionsFor(on('leadId', OTHER), holding('crm.lead.write'), ME)).toBe('all');
    expect(
      followUpActionsFor(on('opportunityId', null), holding('crm.opportunity.write'), ME),
    ).toBe('all');
    expect(followUpActionsFor(on('customerId', OTHER), holding('customer.write'), ME)).toBe('all');
    expect(followUpActionsFor(on('contactId', OTHER), holding('customer.write'), ME)).toBe('all');
    expect(followUpActionsFor(on('quotationId', OTHER), holding('quotation.draft'), ME)).toBe(
      'all',
    );
  });

  it("gives Complete alone to the assignee without the subject's write", () => {
    expect(followUpActionsFor(on('customerId', ME), holding('customer.read'), ME)).toBe('complete');
    // Another subject's write does not count.
    expect(followUpActionsFor(on('customerId', ME), holding('crm.lead.write'), ME)).toBe(
      'complete',
    );
  });

  it('follows receivables permissions for a collection call, assignee or not', () => {
    const call = { ...on('customerId', ME), kind: 'collection_call' };
    // Finance covering for the assignee gets every action; the customer grants do not matter.
    expect(
      followUpActionsFor(
        { ...call, assigneeUserId: OTHER },
        holding('ar.read', 'payment.record'),
        ME,
      ),
    ).toBe('all');
    // The customer's write and the assignee role are not enough without both receivables grants.
    expect(followUpActionsFor(call, holding('customer.write'), ME)).toBe('none');
    expect(followUpActionsFor(call, holding('ar.read'), ME)).toBe('none');
  });

  it('gives nothing to a reader who is not the assignee, or when the caller is unknown', () => {
    expect(followUpActionsFor(on('customerId', OTHER), holding('customer.read'), ME)).toBe('none');
    expect(followUpActionsFor(on('leadId', null), holding('crm.lead.read'), ME)).toBe('none');
    expect(followUpActionsFor(on('leadId', ME), holding('crm.lead.read'), null)).toBe('none');
  });
});

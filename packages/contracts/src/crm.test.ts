import { describe, expect, it } from 'vitest';

import {
  ActivityDtoSchema,
  ActivityKindSchema,
  UpdateLeadBodySchema,
  type ChecklistItem,
  ContactWithEmailBodySchema,
  ConvertLeadBodySchema,
  CreateActivityBodySchema,
  CreateContactBodySchema,
  CreateCustomerBodySchema,
  CustomerFieldsSchema,
  CreateLeadBodySchema,
  LEAD_STAGES,
  LEAD_TRANSITIONS,
  LeadStageChangeBodySchema,
  LeadIngestBodySchema,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TRANSITIONS,
  OpportunityStageChangeBodySchema,
  ReorderLeadLostReasonsBodySchema,
  ResetLeadLostReasonsBodySchema,
  STAGE_CATALOGUE,
  UpdateCustomerBodySchema,
  VerificationCaseDtoSchema,
  findTransition,
  isChecklistComplete,
  lostReasonsToken,
} from './index.js';

const address = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };

describe('CreateCustomerBodySchema', () => {
  const contact = { fullName: 'Sita Rai', email: 'sita@himal.example' };
  const ok = { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: '301234567', address, contact };

  it('parses a customer and defaults the relationship to prospect', () => {
    const c = CreateCustomerBodySchema.parse(ok);
    expect(c.relationship).toBe('prospect');
    expect(c.panVatNo).toBe('301234567');
  });

  it('rejects an unknown relationship, a malformed PAN and a missing name', () => {
    expect(CreateCustomerBodySchema.safeParse({ ...ok, relationship: 'vip' }).success).toBe(false);
    expect(CreateCustomerBodySchema.safeParse({ ...ok, panVatNo: '12 34' }).success).toBe(false);
    expect(CreateCustomerBodySchema.safeParse({ ...ok, legalName: ' ' }).success).toBe(false);
  });

  it('keeps the party id free of any organization: a customer is tenant-level (D17)', () => {
    const parsed = CreateCustomerBodySchema.safeParse({
      ...ok,
      organizationId: crypto.randomUUID(),
    });
    expect(parsed.success).toBe(false);
  });

  it('needs a first contact with an email (a quotation is sent by email)', () => {
    const { contact: _none, ...noContact } = ok;
    expect(CreateCustomerBodySchema.safeParse(noContact).success).toBe(false);
    expect(
      CreateCustomerBodySchema.safeParse({ ...ok, contact: { fullName: 'Sita Rai' } }).success,
    ).toBe(false);
    expect(
      CreateCustomerBodySchema.safeParse({ ...ok, contact: { ...contact, email: 'nope' } }).success,
    ).toBe(false);
    // The first contact is always the main one: the client does not choose.
    expect(
      CreateCustomerBodySchema.safeParse({ ...ok, contact: { ...contact, isPrimary: false } })
        .success,
    ).toBe(false);
  });

  it('keeps the customer fields alone for an edit and a conversion', () => {
    const { contact: _none, ...fields } = ok;
    expect(CustomerFieldsSchema.safeParse(fields).success).toBe(true);
    expect(CustomerFieldsSchema.safeParse(ok).success).toBe(false);
    expect(UpdateCustomerBodySchema.safeParse({ expectedVersion: 1, contact }).success).toBe(false);
  });
});

describe('CreateContactBodySchema and ContactWithEmailBodySchema', () => {
  it('lets a later contact omit the email, but not a contact that must carry one', () => {
    expect(CreateContactBodySchema.safeParse({ fullName: 'Ravi' }).success).toBe(true);
    expect(ContactWithEmailBodySchema.safeParse({ fullName: 'Ravi' }).success).toBe(false);
    expect(
      ContactWithEmailBodySchema.safeParse({ fullName: 'Ravi', email: 'ravi@x.example' }).success,
    ).toBe(true);
  });
});

describe('stage catalogue', () => {
  it('lists the six lead stages and has no "Engaged"', () => {
    expect([...LEAD_STAGES]).toEqual([
      'new',
      'contacted',
      'qualified',
      'converted',
      'lost',
      'on_hold',
    ]);
    const all = STAGE_CATALOGUE.map((s) => s.code as string);
    expect(all).not.toContain('engaged');
    expect(all).not.toContain('prospect');
  });

  it('runs opportunities from qualified to won, then lost and on hold', () => {
    expect([...OPPORTUNITY_STAGES]).toEqual([
      'qualified',
      'requirement_received',
      'proposal_sent',
      'quotation_sent',
      'negotiation',
      'won',
      'lost',
      'on_hold',
    ]);
  });

  it('is keyed by record kind, so shared codes do not collide', () => {
    const keys = STAGE_CATALOGUE.map((s) => `${s.recordKind}:${s.code}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('lead:qualified');
    expect(keys).toContain('opportunity:qualified');
    expect(STAGE_CATALOGUE.length).toBe(LEAD_STAGES.length + OPPORTUNITY_STAGES.length);
  });

  it('flags lost and on hold as needing a reason', () => {
    for (const s of STAGE_CATALOGUE) {
      expect(s.needsReason).toBe(s.code === 'lost' || s.code === 'on_hold');
    }
  });
});

describe('stage transition table', () => {
  it('has every edge point at a known stage of its own kind', () => {
    for (const t of LEAD_TRANSITIONS) {
      expect(LEAD_STAGES).toContain(t.from);
      expect(LEAD_STAGES).toContain(t.to);
    }
    for (const t of OPPORTUNITY_TRANSITIONS) {
      expect(OPPORTUNITY_STAGES).toContain(t.from);
      expect(OPPORTUNITY_STAGES).toContain(t.to);
    }
  });

  it('allows the lead edges of the state machine and nothing else', () => {
    const edges = LEAD_TRANSITIONS.map((t) => `${t.from}>${t.to}`).sort();
    expect(edges).toEqual(
      [
        'new>contacted',
        'contacted>qualified',
        'new>lost',
        'contacted>lost',
        'qualified>lost',
        'new>on_hold',
        'contacted>on_hold',
        'qualified>on_hold',
        'on_hold>new',
        'on_hold>contacted',
        'on_hold>qualified',
        'qualified>converted',
        'lost>contacted',
      ].sort(),
    );
  });

  it('refuses new to converted: conversion needs a qualified lead', () => {
    expect(findTransition('lead', 'new', 'converted')).toBeUndefined();
    expect(findTransition('lead', 'qualified', 'converted')?.by).toBe('user');
  });

  it('makes converted terminal for leads and won terminal for opportunities', () => {
    expect(LEAD_TRANSITIONS.some((t) => t.from === 'converted')).toBe(false);
    expect(OPPORTUNITY_TRANSITIONS.some((t) => t.from === 'won')).toBe(false);
  });

  it('lets only the system move an opportunity into won or quotation_sent', () => {
    const into = OPPORTUNITY_TRANSITIONS.filter((t) => t.to === 'won' || t.to === 'quotation_sent');
    expect(into.length).toBeGreaterThan(0);
    for (const t of into) expect(t.by).toBe('system');
    expect(findTransition('opportunity', 'negotiation', 'won')?.by).toBe('system');
    expect(findTransition('opportunity', 'quotation_sent', 'won')?.by).toBe('system');
  });

  it('lets a quote be sent from qualified: a system edge straight to quotation_sent', () => {
    const edge = findTransition('opportunity', 'qualified', 'quotation_sent');
    expect(edge?.by).toBe('system');
    expect(edge?.needsReason).toBe(false);
  });

  it('makes reopening a lost record a manager action', () => {
    expect(findTransition('lead', 'lost', 'contacted')?.by).toBe('manager');
    expect(findTransition('opportunity', 'lost', 'qualified')?.by).toBe('manager');
  });

  it('needs reason and note exactly when moving to lost or on hold', () => {
    for (const t of [...LEAD_TRANSITIONS, ...OPPORTUNITY_TRANSITIONS]) {
      expect(t.needsReason).toBe(t.to === 'lost' || t.to === 'on_hold');
    }
  });

  it('never leaves a stage the diagram forbids: no backward jump past on hold', () => {
    expect(findTransition('opportunity', 'negotiation', 'qualified')).toBeUndefined();
    expect(findTransition('opportunity', 'qualified', 'negotiation')).toBeUndefined();
  });
});

describe('stage change bodies', () => {
  const lost = {
    stage: 'lost',
    reason: 'Went with a competitor',
    note: 'Price was too high',
    expectedVersion: 1,
  };
  // A lead is lost with an option of the tenant's list (D49), not free text.
  const leadLost = {
    stage: 'lost',
    lostReasonId: '11111111-1111-4111-8111-111111111111',
    note: 'Price was too high',
    expectedVersion: 1,
  };

  it('parses a lead move and a lost move with reason and note', () => {
    expect(
      LeadStageChangeBodySchema.safeParse({ stage: 'contacted', expectedVersion: 2 }).success,
    ).toBe(true);
    expect(LeadStageChangeBodySchema.safeParse(leadLost).success).toBe(true);
    expect(
      LeadStageChangeBodySchema.safeParse({
        stage: 'lost',
        newLostReason: 'Slow to reply',
        note: 'n',
        expectedVersion: 1,
      }).success,
    ).toBe(true);
    expect(LeadStageChangeBodySchema.safeParse({ ...lost, stage: 'on_hold' }).success).toBe(true);
  });

  it('refuses free text, both choices, or none as the reason a lead is lost', () => {
    expect(LeadStageChangeBodySchema.safeParse(lost).success).toBe(false);
    expect(
      LeadStageChangeBodySchema.safeParse({ ...leadLost, newLostReason: 'Slow to reply' }).success,
    ).toBe(false);
    expect(
      LeadStageChangeBodySchema.safeParse({ ...leadLost, lostReasonId: undefined }).success,
    ).toBe(false);
  });

  it('rejects "engaged", and "converted" (conversion is its own action)', () => {
    expect(
      LeadStageChangeBodySchema.safeParse({ stage: 'engaged', expectedVersion: 1 }).success,
    ).toBe(false);
    expect(
      LeadStageChangeBodySchema.safeParse({ stage: 'converted', expectedVersion: 1 }).success,
    ).toBe(false);
  });

  it('rejects lost or on_hold without a reason or without a note', () => {
    expect(LeadStageChangeBodySchema.safeParse({ stage: 'lost', expectedVersion: 1 }).success).toBe(
      false,
    );
    expect(LeadStageChangeBodySchema.safeParse({ ...leadLost, note: undefined }).success).toBe(
      false,
    );
    expect(
      LeadStageChangeBodySchema.safeParse({ ...lost, stage: 'on_hold', reason: undefined }).success,
    ).toBe(false);
    expect(
      LeadStageChangeBodySchema.safeParse({ ...lost, stage: 'on_hold', note: ' ' }).success,
    ).toBe(false);
    expect(OpportunityStageChangeBodySchema.safeParse({ ...lost, note: undefined }).success).toBe(
      false,
    );
  });

  it('rejects stage "won" and "quotation_sent" in an opportunity body: system only', () => {
    expect(
      OpportunityStageChangeBodySchema.safeParse({ stage: 'won', expectedVersion: 1 }).success,
    ).toBe(false);
    expect(
      OpportunityStageChangeBodySchema.safeParse({ stage: 'quotation_sent', expectedVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      OpportunityStageChangeBodySchema.safeParse({ stage: 'negotiation', expectedVersion: 1 })
        .success,
    ).toBe(true);
  });

  it('requires lostReasonId or newLostReason plus note when marking an opportunity lost, and keeps on_hold on free text', () => {
    expect(OpportunityStageChangeBodySchema.safeParse(leadLost).success).toBe(true);
    expect(
      OpportunityStageChangeBodySchema.safeParse({
        stage: 'lost',
        newLostReason: 'Slow to reply',
        note: 'n',
        expectedVersion: 1,
      }).success,
    ).toBe(true);
    expect(OpportunityStageChangeBodySchema.safeParse(lost).success).toBe(false);
    expect(
      OpportunityStageChangeBodySchema.safeParse({ ...leadLost, newLostReason: 'Slow' }).success,
    ).toBe(false);
    expect(
      OpportunityStageChangeBodySchema.safeParse({ ...leadLost, lostReasonId: undefined }).success,
    ).toBe(false);
    expect(
      OpportunityStageChangeBodySchema.safeParse({ ...leadLost, note: undefined }).success,
    ).toBe(false);
    expect(
      OpportunityStageChangeBodySchema.safeParse({
        stage: 'negotiation',
        lostReasonId: leadLost.lostReasonId,
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      OpportunityStageChangeBodySchema.safeParse({
        stage: 'on_hold',
        newLostReason: 'Wait',
        reason: 'budget',
        note: 'next quarter',
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(OpportunityStageChangeBodySchema.safeParse({ ...lost, stage: 'on_hold' }).success).toBe(
      true,
    );
    expect(
      OpportunityStageChangeBodySchema.safeParse({
        ...lost,
        stage: 'on_hold',
        reason: undefined,
      }).success,
    ).toBe(false);
  });

  it('accepts contactActivity only on contacted and only for call, email or meeting', () => {
    expect(
      LeadStageChangeBodySchema.safeParse({
        stage: 'contacted',
        expectedVersion: 1,
        contactActivity: { kind: 'call', body: 'Spoke with buyer' },
      }).success,
    ).toBe(true);
    expect(
      LeadStageChangeBodySchema.safeParse({
        stage: 'contacted',
        expectedVersion: 1,
        contactActivity: { kind: 'email', subject: 'Intro', body: 'Sent brochure' },
      }).success,
    ).toBe(true);
    expect(
      LeadStageChangeBodySchema.safeParse({
        stage: 'contacted',
        expectedVersion: 1,
        contactActivity: { kind: 'meeting', body: 'Met at their office' },
      }).success,
    ).toBe(true);

    for (const stage of ['qualified', 'on_hold', 'lost'] as const) {
      const base =
        stage === 'lost'
          ? leadLost
          : stage === 'on_hold'
            ? { ...lost, stage: 'on_hold' as const }
            : { stage, expectedVersion: 1 };
      const parsed = LeadStageChangeBodySchema.safeParse({
        ...base,
        contactActivity: { kind: 'call', body: 'Should fail' },
      });
      expect(parsed.success, stage).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['contactActivity'],
            message: 'only for a move to contacted',
          }),
        );
      }
    }

    for (const badKind of ['note', 'stage_change', 'collection_call'] as const) {
      expect(
        LeadStageChangeBodySchema.safeParse({
          stage: 'contacted',
          expectedVersion: 1,
          contactActivity: { kind: badKind, body: 'Wrong kind' },
        }).success,
        badKind,
      ).toBe(false);
    }

    expect(
      LeadStageChangeBodySchema.safeParse({
        stage: 'contacted',
        expectedVersion: 1,
        contactActivity: { kind: 'call', body: '   ' },
      }).success,
    ).toBe(false);
  });
});

describe('lostReasonsToken and stale-view schemas (D54-4)', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const c = '33333333-3333-4333-8333-333333333333';
  const base = [
    { id: a, position: 0, version: 1, retired: false },
    { id: b, position: 1, version: 1, retired: false },
  ];

  it('is stable for the same list regardless of input array order', () => {
    const token = lostReasonsToken(base);
    expect(token).toMatch(/^[0-9a-f]{14}$/);
    expect(lostReasonsToken(base)).toBe(token);
    expect(lostReasonsToken([base[1]!, base[0]!])).toBe(token);
  });

  it('changes when order, version, retired state, or membership changes', () => {
    const token = lostReasonsToken(base);
    // Reordered positions
    expect(
      lostReasonsToken([
        { id: a, position: 1, version: 1, retired: false },
        { id: b, position: 0, version: 1, retired: false },
      ]),
    ).not.toBe(token);
    // Version bumped (e.g. rename)
    expect(
      lostReasonsToken([
        { id: a, position: 0, version: 2, retired: false },
        { id: b, position: 1, version: 1, retired: false },
      ]),
    ).not.toBe(token);
    // Retired flag toggled
    expect(
      lostReasonsToken([
        { id: a, position: 0, version: 1, retired: true },
        { id: b, position: 1, version: 1, retired: false },
      ]),
    ).not.toBe(token);
    // Option added
    expect(
      lostReasonsToken([...base, { id: c, position: 2, version: 1, retired: false }]),
    ).not.toBe(token);
  });

  it('requires expectedOrder on reorder and reset bodies', () => {
    const token = lostReasonsToken(base);
    expect(
      ReorderLeadLostReasonsBodySchema.safeParse({ ids: [b, a], expectedOrder: token }).success,
    ).toBe(true);
    expect(ReorderLeadLostReasonsBodySchema.safeParse({ ids: [b, a] }).success).toBe(false);
    expect(
      ReorderLeadLostReasonsBodySchema.safeParse({ ids: [b, a], expectedOrder: '' }).success,
    ).toBe(false);
    expect(ResetLeadLostReasonsBodySchema.safeParse({ expectedOrder: token }).success).toBe(true);
    expect(ResetLeadLostReasonsBodySchema.safeParse({}).success).toBe(false);
    expect(
      ResetLeadLostReasonsBodySchema.safeParse({ expectedOrder: 'x'.repeat(33) }).success,
    ).toBe(false);
  });
});

describe('lead follow-up (D39)', () => {
  const lead = {
    title: 'T',
    source: 'website',
    companyName: 'Acme',
    contactName: 'Asha',
  };
  const due = '2026-12-01T10:00:00+05:45';

  it('takes a planned follow-up, or the old nextFollowUpAt, not both', () => {
    expect(
      CreateLeadBodySchema.safeParse({ ...lead, followUp: { kind: 'call', dueAt: due } }).success,
    ).toBe(true);
    expect(CreateLeadBodySchema.safeParse({ ...lead, nextFollowUpAt: due }).success).toBe(true);
    expect(
      CreateLeadBodySchema.safeParse({
        ...lead,
        nextFollowUpAt: due,
        followUp: { kind: 'call', dueAt: due },
      }).success,
    ).toBe(false);
  });

  it('does not default the currency on an edit, so an owner change cannot reset it', () => {
    const parsed = UpdateLeadBodySchema.parse({
      expectedVersion: 2,
      ownerUserId: crypto.randomUUID(),
    });
    expect('currency' in parsed).toBe(false);
    expect(CreateLeadBodySchema.parse(lead).currency).toBe('NPR');
  });

  it('refuses a note as a follow-up, and does not let an edit change the follow-up', () => {
    expect(
      CreateLeadBodySchema.safeParse({ ...lead, followUp: { kind: 'note', dueAt: due } }).success,
    ).toBe(false);
    expect(
      UpdateLeadBodySchema.safeParse({ expectedVersion: 1, nextFollowUpAt: due }).success,
    ).toBe(false);
    expect(
      UpdateLeadBodySchema.safeParse({ expectedVersion: 1, ownerUserId: crypto.randomUUID() })
        .success,
    ).toBe(true);
  });
});

describe('CreateLeadBodySchema', () => {
  const ok = {
    title: 'Solar rooftop for Himal Traders',
    source: 'referral',
    companyName: 'Himal Traders',
    contactName: 'Sita Rai',
    email: 'sita@himal.example',
    expectedValue: '1500000.00',
    currency: 'NPR',
    probability: 40,
  };

  it('parses a lead and keeps money as a string', () => {
    expect(CreateLeadBodySchema.parse(ok).expectedValue).toBe('1500000.00');
  });

  it('rejects a JS number for money, a bad source and a probability over 100', () => {
    expect(CreateLeadBodySchema.safeParse({ ...ok, expectedValue: 1500000 }).success).toBe(false);
    expect(CreateLeadBodySchema.safeParse({ ...ok, source: 'psychic' }).success).toBe(false);
    expect(CreateLeadBodySchema.safeParse({ ...ok, probability: 101 }).success).toBe(false);
    expect(CreateLeadBodySchema.safeParse({ ...ok, expectedValue: '-5.00' }).success).toBe(false);
  });
});

describe('ConvertLeadBodySchema', () => {
  const newCustomer = {
    mode: 'create',
    customer: { legalName: 'Himal Traders Pvt. Ltd.', address },
  } as const;
  const newContact = {
    mode: 'create',
    contact: { fullName: 'Sita Rai', email: 'sita@himal.example' },
  } as const;

  it('parses a conversion that creates a customer', () => {
    expect(
      ConvertLeadBodySchema.safeParse({
        customer: newCustomer,
        contact: newContact,
        opportunityName: 'Rooftop',
        expectedVersion: 3,
      }).success,
    ).toBe(true);
  });

  it('parses a conversion onto an existing customer', () => {
    const existing = { mode: 'existing', customerId: crypto.randomUUID() };
    expect(
      ConvertLeadBodySchema.safeParse({
        customer: existing,
        contact: { mode: 'existing', contactId: crypto.randomUUID() },
        opportunityName: 'Rooftop',
        expectedVersion: 3,
      }).success,
    ).toBe(true);
  });

  it('needs a contact, and a new contact needs an email', () => {
    const base = { customer: newCustomer, opportunityName: 'Rooftop', expectedVersion: 3 };
    expect(ConvertLeadBodySchema.safeParse(base).success).toBe(false);
    expect(
      ConvertLeadBodySchema.safeParse({
        ...base,
        contact: { mode: 'create', contact: { fullName: 'Sita Rai' } },
      }).success,
    ).toBe(false);
    // The new customer itself carries no contact: the conversion names it separately.
    expect(
      ConvertLeadBodySchema.safeParse({
        ...base,
        contact: newContact,
        customer: {
          ...newCustomer,
          customer: { ...newCustomer.customer, contact: newContact.contact },
        },
      }).success,
    ).toBe(false);
  });

  it('needs a reason to "create anyway" over a duplicate warning', () => {
    const base = {
      customer: newCustomer,
      contact: newContact,
      opportunityName: 'Rooftop',
      expectedVersion: 3,
    };
    expect(ConvertLeadBodySchema.safeParse({ ...base, duplicateOverride: {} }).success).toBe(false);
    expect(
      ConvertLeadBodySchema.safeParse({ ...base, duplicateOverride: { reason: ' ' } }).success,
    ).toBe(false);
    expect(
      ConvertLeadBodySchema.safeParse({
        ...base,
        duplicateOverride: { reason: 'Different branch' },
      }).success,
    ).toBe(true);
  });
});

describe('activities: exactly one primary subject', () => {
  const id = () => crypto.randomUUID();
  const base = { kind: 'call', subject: 'Intro call' };

  it('accepts one subject', () => {
    expect(CreateActivityBodySchema.safeParse({ ...base, leadId: id() }).success).toBe(true);
    expect(CreateActivityBodySchema.safeParse({ ...base, quotationId: id() }).success).toBe(true);
  });

  it('rejects no subject and two subjects', () => {
    expect(CreateActivityBodySchema.safeParse(base).success).toBe(false);
    expect(
      CreateActivityBodySchema.safeParse({ ...base, leadId: id(), customerId: id() }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind, and task, which is now a planned call, meeting or email', () => {
    expect(
      CreateActivityBodySchema.safeParse({ kind: 'telepathy', subject: 'x', leadId: id() }).success,
    ).toBe(false);
    expect(
      CreateActivityBodySchema.safeParse({ kind: 'task', subject: 'x', leadId: id() }).success,
    ).toBe(false);
  });

  it('plans a call, meeting or email with dueAt, but not a note, and never with occurredAt', () => {
    const planned = { ...base, leadId: id(), dueAt: '2026-12-01T10:00:00+05:45' };
    expect(CreateActivityBodySchema.safeParse(planned).success).toBe(true);
    expect(CreateActivityBodySchema.safeParse({ ...planned, kind: 'note' }).success).toBe(false);
    expect(
      CreateActivityBodySchema.safeParse({ ...planned, occurredAt: '2026-11-30T10:00:00+05:45' })
        .success,
    ).toBe(false);
  });

  it('keeps task readable on the DTO so rows written before D39 still parse', () => {
    expect(ActivityKindSchema.safeParse('task').success).toBe(true);
  });

  it('holds the same rule on the DTO, with nulls for the unused subjects', () => {
    const dto = {
      id: id(),
      kind: 'note',
      subject: 's',
      body: null,
      leadId: id(),
      opportunityId: null,
      customerId: null,
      contactId: null,
      quotationId: null,
      dueAt: null,
      assigneeUserId: null,
      assigneeName: null,
      completedAt: null,
      cancelledAt: null,
      planned: false,
      createdByUserId: null,
      createdByName: null,
      occurredAt: '2026-11-08T10:00:00+05:45',
      version: 1,
    };
    expect(ActivityDtoSchema.safeParse(dto).success).toBe(true);
    expect(ActivityDtoSchema.safeParse({ ...dto, leadId: null }).success).toBe(false);
    expect(ActivityDtoSchema.safeParse({ ...dto, customerId: id() }).success).toBe(false);
  });
});

describe('verification case', () => {
  const doc = crypto.randomUUID();
  const item = (
    key: ChecklistItem['key'],
    status: ChecklistItem['status'],
    required = true,
  ): ChecklistItem => ({
    key,
    required,
    status,
    documentId: status === 'missing' ? null : doc,
    expiresOn: null,
  });

  it('parses a case with its checklist', () => {
    const c = {
      id: crypto.randomUUID(),
      partyId: crypto.randomUUID(),
      status: 'draft',
      checklist: [item('registration_certificate', 'missing')],
      reviewedBy: null,
      decidedAt: null,
      decisionNote: null,
      version: 1,
    };
    expect(VerificationCaseDtoSchema.safeParse(c).success).toBe(true);
    expect(VerificationCaseDtoSchema.safeParse({ ...c, status: 'verified-ish' }).success).toBe(
      false,
    );
  });

  it('is complete only when every required item is accepted', () => {
    expect(
      isChecklistComplete([
        item('registration_certificate', 'accepted'),
        item('pan_vat_certificate', 'accepted'),
      ]),
    ).toBe(true);
    expect(
      isChecklistComplete([
        item('registration_certificate', 'accepted'),
        item('pan_vat_certificate', 'provided'),
      ]),
    ).toBe(false);
    expect(
      isChecklistComplete([
        item('registration_certificate', 'accepted'),
        item('address_proof', 'missing', false),
      ]),
    ).toBe(true);
    expect(isChecklistComplete([])).toBe(false);
  });
});

describe('LeadIngestBodySchema (website, untrusted)', () => {
  const ok = { companyName: 'Acme', contactName: 'Jo', email: 'jo@acme.example', message: 'Hello' };

  it('parses a minimal lead with an email, or with only a phone', () => {
    expect(LeadIngestBodySchema.safeParse(ok).success).toBe(true);
    expect(
      LeadIngestBodySchema.safeParse({
        companyName: 'Acme',
        contactName: 'Jo',
        phone: '+9779812345678',
      }).success,
    ).toBe(true);
  });

  it('requires an email or a phone', () => {
    expect(LeadIngestBodySchema.safeParse({ companyName: 'Acme', contactName: 'Jo' }).success).toBe(
      false,
    );
  });

  it('refuses fields the website must not set: stage, owner, probability, source', () => {
    for (const extra of [
      { stage: 'qualified' },
      { ownerUserId: crypto.randomUUID() },
      { probability: 99 },
      { tenantId: 'x' },
    ]) {
      expect(LeadIngestBodySchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    }
  });

  it('caps field lengths and accepts an external reference for idempotency', () => {
    expect(LeadIngestBodySchema.safeParse({ ...ok, message: 'x'.repeat(5001) }).success).toBe(
      false,
    );
    expect(LeadIngestBodySchema.safeParse({ ...ok, companyName: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(LeadIngestBodySchema.parse({ ...ok, externalRef: 'wp-form-123' }).externalRef).toBe(
      'wp-form-123',
    );
  });
});

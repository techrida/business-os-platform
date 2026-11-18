import { describe, expect, it } from 'vitest';

import {
  kathmanduLocalToIso,
  parseActivity,
  parseConvert,
  parseLead,
  parseStageMove,
} from './forms';

const GUID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('parseStageMove', () => {
  it('accepts a plain move and reads the version as a number', () => {
    const r = parseStageMove('lead', form({ stage: 'contacted', expectedVersion: '3' }));
    expect(r).toEqual({ ok: true, data: { stage: 'contacted', expectedVersion: 3 } });
  });

  it('refuses lost and on_hold without both a reason and a note', () => {
    const r = parseStageMove('lead', form({ stage: 'lost', expectedVersion: '1' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(['note', 'reason']);

    const half = parseStageMove(
      'opportunity',
      form({ stage: 'on_hold', reason: 'Budget freeze', expectedVersion: '1' }),
    );
    expect(half.ok).toBe(false);
    if (!half.ok) expect(Object.keys(half.fieldErrors)).toEqual(['note']);
  });

  it('accepts lost with a reason and a note', () => {
    const r = parseStageMove(
      'lead',
      form({ stage: 'lost', reason: 'No budget', note: 'Called twice', expectedVersion: '2' }),
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a system-only stage even if the browser sends it', () => {
    for (const stage of ['won', 'quotation_sent']) {
      const r = parseStageMove('opportunity', form({ stage, expectedVersion: '1' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fieldErrors.stage).toBeDefined();
    }
    const c = parseStageMove('lead', form({ stage: 'converted', expectedVersion: '1' }));
    expect(c.ok).toBe(false);
  });

  it('refuses a missing version with a reload message', () => {
    const r = parseStageMove('lead', form({ stage: 'contacted' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.expectedVersion).toMatch(/reload/i);
  });
});

describe('parseLead', () => {
  const base = {
    title: 'Dispatch automation',
    source: 'referral',
    companyName: 'Binford Ltd.',
    contactName: 'Sunita Shrestha',
  };

  it('drops empty optional fields and strips grouping from the value', () => {
    const r = parseLead(
      form({
        ...base,
        email: '',
        phone: '',
        expectedValue: '12,50,000.50',
        currency: 'NPR',
        probability: '',
      }),
    );
    expect(r).toEqual({
      ok: true,
      data: { ...base, expectedValue: '1250000.50', currency: 'NPR' },
    });
  });

  it('names each bad field in words', () => {
    const r = parseLead(
      form({ ...base, title: '', phone: '98123', expectedValue: 'abc', probability: '120' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors).sort()).toEqual([
        'expectedValue',
        'phone',
        'probability',
        'title',
      ]);
      expect(r.fieldErrors.phone).toMatch(/\+977/);
    }
  });
});

describe('parseActivity', () => {
  it('builds a body with exactly the one subject it was given', () => {
    const r = parseActivity(
      form({
        kind: 'call',
        subject: 'Intro call',
        body: 'Went well',
        subjectKind: 'leadId',
        subjectId: GUID,
      }),
    );
    expect(r).toEqual({
      ok: true,
      data: { kind: 'call', subject: 'Intro call', body: 'Went well', leadId: GUID },
    });
  });

  it('refuses a subject kind that is not one of the five records, or a missing id', () => {
    const wrongKind = form({ kind: 'note', subject: 'x', subjectKind: 'userId', subjectId: GUID });
    expect(parseActivity(wrongKind).ok).toBe(false);
    const noId = form({ kind: 'note', subject: 'x', subjectKind: 'leadId', subjectId: '' });
    expect(parseActivity(noId).ok).toBe(false);
  });

  it('refuses kinds only the server writes', () => {
    const r = parseActivity(
      form({ kind: 'stage_change', subject: 'x', subjectKind: 'leadId', subjectId: GUID }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.kind).toBeDefined();
  });

  it('turns a due date typed in Kathmandu time into an offset timestamp', () => {
    expect(kathmanduLocalToIso('2026-11-08T10:30')).toBe('2026-11-08T10:30:00+05:45');
    expect(kathmanduLocalToIso('')).toBeUndefined();
    const r = parseActivity(
      form({
        kind: 'task',
        subject: 'Send brochure',
        dueAt: '2026-11-09T09:00',
        subjectKind: 'opportunityId',
        subjectId: OTHER,
      }),
    );
    expect(r.ok && r.data.dueAt).toBe('2026-11-09T09:00:00+05:45');
  });
});

describe('parseConvert', () => {
  const create = {
    customerMode: 'create',
    legalName: 'Binford Ltd.',
    line1: 'Ring Road',
    city: 'Kathmandu',
    country: 'NP',
    opportunityName: 'Binford dispatch automation',
    expectedVersion: '4',
  };
  const withContact = {
    contactMode: 'create',
    contactName: 'Sunita Shrestha',
    contactEmail: 'sunita@binford.example',
  };

  it('needs a contact, and a new one needs an email (quotations are emailed)', () => {
    for (const extra of [{}, { contactMode: 'none' }]) {
      const none = parseConvert(form({ ...create, ...extra }));
      expect(none.ok, JSON.stringify(extra)).toBe(false);
      if (!none.ok) expect(none.fieldErrors.contactMode).toMatch(/choose a contact/i);
    }
    const noEmail = parseConvert(form({ ...create, ...withContact, contactEmail: '' }));
    expect(noEmail.ok).toBe(false);
    if (!noEmail.ok) expect(noEmail.fieldErrors.contactEmail).toMatch(/quotations are sent/i);
  });

  it('makes a new contact the main one only for a new customer', () => {
    const forNew = parseConvert(form({ ...create, ...withContact }));
    expect(forNew.ok && forNew.data.contact).toMatchObject({ contact: { isPrimary: true } });
    const forExisting = parseConvert(
      form({
        ...create,
        ...withContact,
        customerMode: 'existing',
        customerId: GUID,
      }),
    );
    expect(forExisting.ok && forExisting.data.contact).toMatchObject({
      contact: { isPrimary: false },
    });
  });

  it('builds create-customer with a contact from the lead', () => {
    const r = parseConvert(
      form({
        ...create,
        contactMode: 'create',
        contactName: 'Sunita Shrestha',
        contactEmail: 'sunita@binford.example',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.customer).toMatchObject({
        mode: 'create',
        customer: { legalName: 'Binford Ltd.', relationship: 'prospect' },
      });
      expect(r.data.contact).toMatchObject({
        mode: 'create',
        contact: { fullName: 'Sunita Shrestha' },
      });
      expect(r.data.opportunityName).toBe('Binford dispatch automation');
      expect(r.data.expectedVersion).toBe(4);
      expect(r.data.duplicateOverride).toBeUndefined();
    }
  });

  it('builds link-to-existing and needs a valid customer id', () => {
    const ok = parseConvert(
      form({
        customerMode: 'existing',
        customerId: GUID,
        contactMode: 'existing',
        contactId: GUID,
        opportunityName: 'Deal',
        expectedVersion: '1',
      }),
    );
    expect(ok.ok && ok.data.customer).toEqual({ mode: 'existing', customerId: GUID });
    expect(ok.ok && ok.data.contact).toEqual({ mode: 'existing', contactId: GUID });
    const bad = parseConvert(
      form({
        customerMode: 'existing',
        customerId: 'not-an-id',
        contactMode: 'existing',
        contactId: GUID,
        opportunityName: 'Deal',
        expectedVersion: '1',
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors.customerId).toBeDefined();
  });

  it('adds the duplicate override only with a reason, and asks for one when create anyway is ticked', () => {
    const withReason = parseConvert(
      form({
        ...create,
        ...withContact,
        createAnyway: 'on',
        overrideReason: 'Different branch',
      }),
    );
    expect(withReason.ok && withReason.data.duplicateOverride).toEqual({
      reason: 'Different branch',
    });
    const missing = parseConvert(form({ ...create, ...withContact, createAnyway: 'on' }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.fieldErrors.overrideReason).toBeDefined();
    const unticked = parseConvert(
      form({ ...create, ...withContact, overrideReason: 'Left over text' }),
    );
    expect(unticked.ok && unticked.data.duplicateOverride).toBeUndefined();
  });

  it('needs an opportunity name', () => {
    const r = parseConvert(form({ ...create, ...withContact, opportunityName: '  ' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.opportunityName).toBeDefined();
  });
});

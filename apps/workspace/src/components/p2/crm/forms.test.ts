import { NO_SPACES } from '@bos/locale';
import { describe, expect, it } from 'vitest';

import {
  EMAIL_OR_PHONE,
  isOverdue,
  isPastDue,
  kathmanduLocalToIso,
  parseActivity,
  parseCancelActivity,
  parseCompleteActivity,
  parseConvert,
  parseLead,
  parseLeadUpdate,
  parseRescheduleActivity,
  parseScheduleFollowUp,
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
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(['lostReasonId', 'note']);

    const half = parseStageMove(
      'opportunity',
      form({ stage: 'on_hold', reason: 'Budget freeze', expectedVersion: '1' }),
    );
    expect(half.ok).toBe(false);
    if (!half.ok) expect(Object.keys(half.fieldErrors)).toEqual(['note']);
  });

  it('accepts a lead lost with a chosen reason and a note (D49)', () => {
    const id = '7b0e6c1a-2f4d-4c55-8a39-6d1f5e2c9b10';
    const r = parseStageMove(
      'lead',
      form({ stage: 'lost', lostReasonId: id, note: 'Called twice', expectedVersion: '2' }),
    );
    expect(r).toEqual({
      ok: true,
      data: { stage: 'lost', lostReasonId: id, note: 'Called twice', expectedVersion: 2 },
    });
  });

  it('accepts a lead lost with a new reason typed in the dialog, trimmed', () => {
    const r = parseStageMove(
      'lead',
      form({ stage: 'lost', newLostReason: '  Slow to reply ', note: 'n', expectedVersion: '2' }),
    );
    expect(r).toMatchObject({ ok: true, data: { newLostReason: 'Slow to reply' } });
  });

  it('refuses a lead lost with the old free-text reason, with both choices, or with a reason over 60 characters', () => {
    const id = '7b0e6c1a-2f4d-4c55-8a39-6d1f5e2c9b10';
    const old = parseStageMove(
      'lead',
      form({ stage: 'lost', reason: 'No budget', note: 'n', expectedVersion: '2' }),
    );
    expect(old.ok).toBe(false);
    const both = parseStageMove(
      'lead',
      form({
        stage: 'lost',
        lostReasonId: id,
        newLostReason: 'x',
        note: 'n',
        expectedVersion: '2',
      }),
    );
    expect(both.ok).toBe(false);
    const long = parseStageMove(
      'lead',
      form({ stage: 'lost', newLostReason: 'x'.repeat(61), note: 'n', expectedVersion: '2' }),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.fieldErrors['newLostReason']).toMatch(/60 characters/);
  });

  it('accepts an opportunity lost with a chosen reason or a new trimmed reason (D54-3)', () => {
    const id = '7b0e6c1a-2f4d-4c55-8a39-6d1f5e2c9b10';
    const picked = parseStageMove(
      'opportunity',
      form({ stage: 'lost', lostReasonId: id, note: 'Went elsewhere', expectedVersion: '3' }),
    );
    expect(picked).toEqual({
      ok: true,
      data: { stage: 'lost', lostReasonId: id, note: 'Went elsewhere', expectedVersion: 3 },
    });

    const added = parseStageMove(
      'opportunity',
      form({
        stage: 'lost',
        newLostReason: '  Delayed project  ',
        note: 'n',
        expectedVersion: '3',
      }),
    );
    expect(added).toMatchObject({ ok: true, data: { newLostReason: 'Delayed project' } });
  });

  it('refuses an opportunity lost with free-text reason, both choices, missing note, or over 60 characters', () => {
    const id = '7b0e6c1a-2f4d-4c55-8a39-6d1f5e2c9b10';
    const missing = parseStageMove('opportunity', form({ stage: 'lost', expectedVersion: '2' }));
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(Object.keys(missing.fieldErrors).sort()).toEqual(['lostReasonId', 'note']);

    const oldReason = parseStageMove(
      'opportunity',
      form({ stage: 'lost', reason: 'No budget', note: 'Called twice', expectedVersion: '2' }),
    );
    expect(oldReason.ok).toBe(false);

    const both = parseStageMove(
      'opportunity',
      form({
        stage: 'lost',
        lostReasonId: id,
        newLostReason: 'Other',
        note: 'n',
        expectedVersion: '2',
      }),
    );
    expect(both.ok).toBe(false);

    const long = parseStageMove(
      'opportunity',
      form({ stage: 'lost', newLostReason: 'x'.repeat(61), note: 'n', expectedVersion: '2' }),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.fieldErrors['newLostReason']).toMatch(/60 characters/);
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

  it('parses contactActivity on a lead move to contacted (D48)', () => {
    const withSubject = parseStageMove(
      'lead',
      form({
        stage: 'contacted',
        expectedVersion: '3',
        contactKind: 'email',
        contactSubject: '  Intro email  ',
        contactBody: '  Sent overview deck.  ',
      }),
    );
    expect(withSubject).toEqual({
      ok: true,
      data: {
        stage: 'contacted',
        expectedVersion: 3,
        contactActivity: {
          kind: 'email',
          subject: 'Intro email',
          body: 'Sent overview deck.',
        },
      },
    });

    const withoutSubject = parseStageMove(
      'lead',
      form({
        stage: 'contacted',
        expectedVersion: '3',
        contactKind: 'call',
        contactSubject: '   ',
        contactBody: 'Spoke with Sunita.',
      }),
    );
    expect(withoutSubject).toEqual({
      ok: true,
      data: {
        stage: 'contacted',
        expectedVersion: 3,
        contactActivity: {
          kind: 'call',
          body: 'Spoke with Sunita.',
        },
      },
    });

    const wrongStage = parseStageMove(
      'lead',
      form({
        stage: 'qualified',
        expectedVersion: '3',
        contactKind: 'call',
        contactBody: 'Should not be accepted on qualify.',
      }),
    );
    expect(wrongStage.ok).toBe(false);
    if (!wrongStage.ok) {
      expect(wrongStage.fieldErrors['contactActivity']).toContain('moving to Contacted');
    }
  });

  it('accepts a meeting as the contact logged on a move to Contacted', () => {
    expect(
      parseStageMove(
        'lead',
        form({
          stage: 'contacted',
          expectedVersion: '3',
          contactKind: 'meeting',
          contactBody: 'Met them at the office.',
        }),
      ),
    ).toEqual({
      ok: true,
      data: {
        stage: 'contacted',
        expectedVersion: 3,
        contactActivity: { kind: 'meeting', body: 'Met them at the office.' },
      },
    });
  });

  it('maps contactActivity validation errors to contactKind, contactSubject and contactBody', () => {
    const noBody = parseStageMove(
      'lead',
      form({ stage: 'contacted', expectedVersion: '3', contactKind: 'call', contactBody: '  ' }),
    );
    expect(noBody.ok).toBe(false);
    if (!noBody.ok) {
      expect(noBody.fieldErrors['contactBody']).toMatch(/call, email or meeting/i);
    }

    const badKind = parseStageMove(
      'lead',
      form({
        stage: 'contacted',
        expectedVersion: '3',
        contactKind: 'note',
        contactBody: 'Wrote it down.',
      }),
    );
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) {
      expect(badKind.fieldErrors['contactKind']).toBe('Choose call, email or meeting.');
    }

    const longSubject = parseStageMove(
      'lead',
      form({
        stage: 'contacted',
        expectedVersion: '3',
        contactKind: 'call',
        contactSubject: 'x'.repeat(201),
        contactBody: 'Called.',
      }),
    );
    expect(longSubject.ok).toBe(false);
    if (!longSubject.ok) {
      expect(longSubject.fieldErrors['contactSubject']).toMatch(/200 characters/);
    }
  });
});

describe('parseLead', () => {
  const base = {
    title: 'Dispatch automation',
    source: 'referral',
    companyName: 'Binford Ltd.',
    contactName: 'Sunita Shrestha',
    country: 'NP',
    email: 'sunita@binford.com.np',
  };
  /** One blank phone row, as the list posts it when nothing was typed. */
  const blankRow = {
    'phones.0.number': '',
    'phones.0.country': 'NP',
    'phones.0.label': '',
    'phones.0.isPrimary': 'true',
  };

  it('drops empty optional fields and strips grouping from the value', () => {
    const r = parseLead(
      form({
        ...base,
        ...blankRow,
        expectedValue: '12,50,000.50',
        currency: 'NPR',
        probability: '',
      }),
    );
    expect(r).toEqual({
      ok: true,
      data: { ...base, phones: [], expectedValue: '1250000.50', currency: 'NPR' },
    });
  });

  it('names each bad field in words', () => {
    const r = parseLead(
      form({
        ...base,
        title: '',
        'phones.0.number': '+97798123',
        'phones.0.country': 'NP',
        'phones.0.isPrimary': 'true',
        expectedValue: 'abc',
        probability: '120',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors).sort()).toEqual([
        'expectedValue',
        'phones.0',
        'probability',
        'title',
      ]);
      expect(r.fieldErrors['phones.0']).toMatch(/Nepal/);
    }
  });

  it('says to remove the space in an expected value typed as 10 50, not read as 1050', () => {
    const r = parseLead(form({ ...base, expectedValue: '10 50', currency: 'NPR' }));
    expect(r).toEqual({ ok: false, fieldErrors: { expectedValue: NO_SPACES } });
  });

  it('builds the country and the phones, each with its own country, blank rows left out', () => {
    const r = parseLead(
      form({
        ...base,
        email: '',
        country: 'US',
        'phones.0.number': '+9779812345678',
        'phones.0.country': 'NP',
        'phones.0.label': 'mobile',
        'phones.0.isPrimary': 'false',
        'phones.1.number': '',
        'phones.1.country': 'NP',
        'phones.1.label': '',
        'phones.1.isPrimary': 'false',
        'phones.2.number': '+14155552671',
        'phones.2.country': 'US',
        'phones.2.label': '',
        'phones.2.isPrimary': 'true',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.country).toBe('US');
      expect(r.data.email).toBeUndefined();
      expect(r.data.phones).toEqual([
        { country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: false },
        { country: 'US', e164: '+14155552671', isPrimary: true },
      ]);
    }
  });

  it('makes the first number primary when the primary row was left blank', () => {
    const r = parseLead(
      form({
        ...base,
        ...blankRow,
        'phones.1.number': '+14155552671',
        'phones.1.country': 'US',
        'phones.1.isPrimary': 'false',
      }),
    );
    expect(r.ok && r.data.phones).toEqual([
      { country: 'US', e164: '+14155552671', isPrimary: true },
    ]);
  });

  it('asks for an email or a phone when neither was given', () => {
    const r = parseLead(form({ ...base, email: '', ...blankRow }));
    expect(r).toEqual({ ok: false, fieldErrors: { email: EMAIL_OR_PHONE } });
  });

  it('puts a number listed twice under the row it was typed in, and a missing country on Country', () => {
    const r = parseLead(
      form({
        ...base,
        country: '',
        ...blankRow,
        'phones.1.number': '+14155552671',
        'phones.1.country': 'US',
        'phones.1.isPrimary': 'false',
        'phones.2.number': '+14155552671',
        'phones.2.country': 'US',
        'phones.2.isPrimary': 'false',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors['phones.2']).toBe('This number is listed twice.');
      expect(r.fieldErrors.country).toMatch(/country/);
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
        kind: 'email',
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
    'address.line': 'Ring Road',
    'address.city': 'Kathmandu',
    'address.country': 'NP',
    opportunityName: 'Binford dispatch automation',
    expectedVersion: '4',
  };
  const withContact = {
    contactMode: 'create',
    contactName: 'Sunita Shrestha',
    contactEmail: 'sunita@binford.example',
    contactCountry: 'NP',
  };

  it('posts the customer country beside its address lines, and refuses an address without a country', () => {
    const r = parseConvert(form({ ...create, ...withContact }));
    expect(r.ok && r.data.customer).toMatchObject({
      mode: 'create',
      customer: { country: 'NP', address: { line: 'Ring Road', city: 'Kathmandu' } },
    });
    const noCountry = parseConvert(form({ ...create, ...withContact, 'address.country': '' }));
    expect(noCountry.ok).toBe(false);
    if (!noCountry.ok) expect(noCountry.fieldErrors['address.country']).toMatch(/country/i);
    const noCity = parseConvert(form({ ...create, ...withContact, 'address.city': ' ' }));
    expect(noCity.ok).toBe(false);
    if (!noCity.ok) expect(noCity.fieldErrors['address.city']).toMatch(/city/i);
  });

  it('refuses a short PAN for a Nepal customer and saves a foreign customer without one', () => {
    const short = parseConvert(form({ ...create, ...withContact, panVatNo: '12345' }));
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.fieldErrors.panVatNo).toBe('A Nepal PAN is 9 digits.');
    const foreign = parseConvert(
      form({ ...create, ...withContact, 'address.country': 'IN', 'address.city': 'Delhi' }),
    );
    expect(foreign.ok && foreign.data.customer).toMatchObject({
      mode: 'create',
      customer: { country: 'IN' },
    });
    if (foreign.ok && foreign.data.customer.mode === 'create') {
      expect(foreign.data.customer.customer.panVatNo).toBeUndefined();
    }
    const foreignTaxId = parseConvert(
      form({ ...create, ...withContact, 'address.country': 'IN', panVatNo: 'AAAPL1234C' }),
    );
    expect(foreignTaxId.ok).toBe(true);
  });

  it('posts the contact country and two phones in different countries as given', () => {
    const r = parseConvert(
      form({
        ...create,
        ...withContact,
        contactCountry: 'US',
        'contactPhones.0.number': '+9779812345678',
        'contactPhones.0.country': 'NP',
        'contactPhones.0.label': 'mobile',
        'contactPhones.0.isPrimary': 'false',
        'contactPhones.1.number': '+14155552671',
        'contactPhones.1.country': 'US',
        'contactPhones.1.label': '',
        'contactPhones.1.isPrimary': 'true',
      }),
    );
    expect(r.ok && r.data.contact).toMatchObject({
      mode: 'create',
      contact: {
        country: 'US',
        phones: [
          { country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: false },
          { country: 'US', e164: '+14155552671', isPrimary: true },
        ],
      },
    });
  });

  it('posts an empty phone list when every row was removed, so the lead’s numbers are not copied back (FX9 A2)', () => {
    // The list keeps one blank row once the last number is removed; a list with no rows posts nothing.
    for (const rows of [{ 'contactPhones.0.number': '', 'contactPhones.0.country': 'NP' }, {}]) {
      const r = parseConvert(form({ ...create, ...withContact, ...rows }));
      expect(r.ok, JSON.stringify(rows)).toBe(true);
      if (r.ok && r.data.contact.mode === 'create') {
        expect(r.data.contact.contact.phones).toEqual([]);
        // The empty list survives the JSON the server action sends; it is not dropped as "unset".
        expect(JSON.stringify(r.data)).toContain('"phones":[]');
      }
    }
  });

  it('puts a refused phone under its row and needs a contact country', () => {
    const r = parseConvert(
      form({
        ...create,
        ...withContact,
        contactCountry: '',
        'contactPhones.0.number': '',
        'contactPhones.0.country': 'NP',
        'contactPhones.0.isPrimary': 'true',
        'contactPhones.1.number': '+1415555',
        'contactPhones.1.country': 'US',
        'contactPhones.1.isPrimary': 'false',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors['contactPhones.1']).toMatch(/United States/);
      expect(r.fieldErrors.contactCountry).toMatch(/country/i);
    }
  });

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
    const r = parseConvert(form({ ...create, ...withContact }));
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

describe('parseLead owner and first follow-up', () => {
  const base = {
    title: 'Dispatch automation',
    source: 'referral',
    companyName: 'Binford Ltd.',
    contactName: 'Sunita Shrestha',
    country: 'NP',
    email: 'sunita@binford.com.np',
  };

  it('sends the chosen owner and plans the follow-up only when it has a time', () => {
    const r = parseLead(
      form({
        ...base,
        ownerUserId: GUID,
        followUpKind: 'meeting',
        followUpAt: '2026-11-20T14:00',
        followUpAssigneeUserId: OTHER,
        followUpSubject: '',
      }),
    );
    expect(r.ok && r.data.ownerUserId).toBe(GUID);
    expect(r.ok && r.data.followUp).toEqual({
      kind: 'meeting',
      dueAt: '2026-11-20T14:00:00+05:45',
      assigneeUserId: OTHER,
    });

    const noTime = parseLead(form({ ...base, followUpKind: 'call', followUpAt: '' }));
    expect(noTime.ok && noTime.data.followUp).toBeUndefined();
  });

  it('refuses a note or task as the first follow-up, on the follow-up type field', () => {
    for (const kind of ['note', 'task']) {
      const r = parseLead(form({ ...base, followUpKind: kind, followUpAt: '2026-11-20T14:00' }));
      expect(r.ok, kind).toBe(false);
      if (!r.ok) expect(r.fieldErrors.followUpKind).toMatch(/call, meeting or email/);
    }
  });

  it('names a bad owner id', () => {
    const r = parseLead(form({ ...base, ownerUserId: 'someone' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.ownerUserId).toMatch(/owns this lead/);
  });
});

describe('parseLeadUpdate', () => {
  it('builds an owner change with the version', () => {
    expect(parseLeadUpdate(form({ ownerUserId: OTHER, expectedVersion: '5' }))).toEqual({
      ok: true,
      data: { ownerUserId: OTHER, expectedVersion: 5 },
    });
  });

  it('needs an owner and a version', () => {
    const r = parseLeadUpdate(form({}));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors.ownerUserId).toBeDefined();
      expect(r.fieldErrors.expectedVersion).toMatch(/reload/i);
    }
  });
});

describe('logging and scheduling activities', () => {
  const onLead = { subjectKind: 'leadId', subjectId: GUID };

  it('refuses task as a logged kind', () => {
    const r = parseActivity(form({ ...onLead, kind: 'task', subject: 'Old habit' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.kind).toBe('Choose call, meeting, email or note.');
  });

  it('logs a note, but refuses a note with a due time', () => {
    expect(parseActivity(form({ ...onLead, kind: 'note', subject: 'Prefers email' })).ok).toBe(
      true,
    );
    const planned = parseActivity(
      form({ ...onLead, kind: 'note', subject: 'x', dueAt: '2026-11-20T09:00' }),
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.fieldErrors.kind).toMatch(/note records something/);
  });

  it('schedules a call with the kind label as the default subject', () => {
    const r = parseScheduleFollowUp(
      form({ ...onLead, kind: 'call', dueAt: '2026-11-20T09:00', assigneeUserId: OTHER }),
    );
    expect(r).toEqual({
      ok: true,
      data: {
        kind: 'call',
        subject: 'Call',
        dueAt: '2026-11-20T09:00:00+05:45',
        assigneeUserId: OTHER,
        leadId: GUID,
      },
    });
  });

  it('refuses to schedule a note or a task, or a follow-up without a time', () => {
    const note = parseScheduleFollowUp(
      form({ ...onLead, kind: 'note', dueAt: '2026-11-20T09:00' }),
    );
    expect(note.ok).toBe(false);
    if (!note.ok) expect(note.fieldErrors.kind).toMatch(/note records something/);

    const task = parseScheduleFollowUp(
      form({ ...onLead, kind: 'task', dueAt: '2026-11-20T09:00' }),
    );
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.fieldErrors.kind).toBe('Choose call, meeting or email.');

    const noTime = parseScheduleFollowUp(form({ ...onLead, kind: 'email', subject: 'Quote' }));
    expect(noTime.ok).toBe(false);
    if (!noTime.ok) expect(Object.keys(noTime.fieldErrors)).toEqual(['dueAt']);

    expect(parseScheduleFollowUp(form({ kind: 'call', dueAt: '2026-11-20T09:00' }))).toEqual({
      ok: false,
      fieldErrors: { form: 'This form is incomplete. Reload the page.' },
    });
  });
});

describe('complete, reschedule and cancel', () => {
  it('builds each body with the version', () => {
    expect(
      parseCompleteActivity(
        form({ expectedVersion: '2', note: 'Agreed a demo', occurredAt: '2026-11-19T16:10' }),
      ),
    ).toEqual({
      ok: true,
      data: { expectedVersion: 2, note: 'Agreed a demo', occurredAt: '2026-11-19T16:10:00+05:45' },
    });
    expect(parseCompleteActivity(form({ expectedVersion: '2', note: '' }))).toEqual({
      ok: true,
      data: { expectedVersion: 2 },
    });
    expect(
      parseRescheduleActivity(form({ expectedVersion: '3', dueAt: '2026-11-21T10:00' })),
    ).toEqual({ ok: true, data: { expectedVersion: 3, dueAt: '2026-11-21T10:00:00+05:45' } });
    expect(parseCancelActivity(form({ expectedVersion: '4' }))).toEqual({
      ok: true,
      data: { expectedVersion: 4 },
    });
  });

  it('asks for a new time to reschedule and a reload when the version is missing', () => {
    const r = parseRescheduleActivity(form({ expectedVersion: '3' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.dueAt).toMatch(/new due time/);
    const stale = parseCancelActivity(form({}));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.fieldErrors.expectedVersion).toMatch(/reload/i);
  });
});

describe('isOverdue', () => {
  const now = new Date('2026-11-19T12:00:00+05:45');

  it('is overdue only when planned and due before now', () => {
    expect(isOverdue({ planned: true, dueAt: '2026-11-19T11:59:00+05:45' }, now)).toBe(true);
    expect(isOverdue({ planned: true, dueAt: '2026-11-19T12:00:00+05:45' }, now)).toBe(false);
    expect(isOverdue({ planned: true, dueAt: '2026-11-20T09:00:00+05:45' }, now)).toBe(false);
    expect(isOverdue({ planned: false, dueAt: '2026-11-01T09:00:00+05:45' }, now)).toBe(false);
    expect(isOverdue({ planned: true, dueAt: null }, now)).toBe(false);
  });

  it('reads a lead next follow-up time the same way', () => {
    expect(isPastDue('2026-11-18T09:00:00+05:45', now)).toBe(true);
    expect(isPastDue(null, now)).toBe(false);
    expect(isPastDue('not a time', now)).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('next/cache', () => cache);
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 't', roles: ['sales'] })),
}));

const api = vi.hoisted(() => ({
  changeLeadStage: vi.fn(),
  createLead: vi.fn(),
  convertLead: vi.fn(),
  createActivity: vi.fn(),
  completeActivity: vi.fn(),
  rescheduleActivity: vi.fn(),
  cancelActivity: vi.fn(),
  updateLead: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => api);

import {
  cancelFollowUpAction,
  completeFollowUpAction,
  convertLeadAction,
  createLeadAction,
  moveLeadStageAction,
  rescheduleFollowUpAction,
  scheduleFollowUpAction,
  updateLeadOwnerAction,
} from './actions';

const IDEM = '44444444-4444-4444-8444-444444444444';
const LEAD = '11111111-1111-4111-8111-111111111111';
const GUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const fields = {
    title: 'Dispatch automation',
    source: 'referral',
    companyName: 'Binford Ltd.',
    contactName: 'Sunita Shrestha',
    idempotencyKey: IDEM,
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const empty = { values: {}, fieldErrors: {} };

beforeEach(() => vi.clearAllMocks());

describe('createLeadAction', () => {
  it('sends the page key as the idempotency key and goes to the new lead', async () => {
    api.createLead.mockResolvedValue({ id: LEAD });
    await expect(createLeadAction(empty, form())).rejects.toThrow(`NEXT_REDIRECT /leads/${LEAD}`);
    expect(api.createLead).toHaveBeenCalledWith(expect.anything(), expect.anything(), IDEM);
  });

  it('keeps the key after a 5xx or a network error, so a retry cannot create a second lead', async () => {
    api.createLead.mockRejectedValueOnce(new ApiError(503, 'down'));
    const first = await createLeadAction(empty, form());
    expect(first.error).toBeTruthy();
    expect(first.key).toBe(IDEM);

    api.createLead.mockRejectedValueOnce(new TypeError('fetch failed'));
    const second = await createLeadAction(empty, form());
    expect(second.error).toBeTruthy();
    expect(second.key).toBe(IDEM);
  });

  it('rotates the key after a definite 4xx, so the next try is a new request', async () => {
    api.createLead.mockRejectedValueOnce(new ApiError(422, 'refused'));
    const res = await createLeadAction(empty, form());
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(IDEM);
  });

  it.each([
    'The first request with this Idempotency-Key did not finish',
    'This Idempotency-Key was released while it was being checked',
  ])('keeps the key after the in-progress 409 "%s", so the retry replays', async (message) => {
    api.createLead.mockRejectedValueOnce(
      new ApiError(409, message, { error: { code: 'conflict', message, correlationId: 'c' } }),
    );
    const res = await createLeadAction(empty, form());
    expect(res.key).toBe(IDEM);
  });

  it('names a currency the company switched off (422) and rotates the key', async () => {
    // The body the API sends today: its error filter does not pass CURRENCY_NOT_ENABLED yet.
    const message = 'Currency INR is not enabled for this company';
    api.createLead.mockRejectedValueOnce(
      new ApiError(422, message, { error: { code: 'bad_request', message, correlationId: 'c' } }),
    );
    const res = await createLeadAction(empty, form());
    // Fails on the old code: failureOf worded every 422 "The platform did not respond".
    expect(res.error).toBe(
      'INR is switched off for your company. Choose another currency, or ask an administrator to switch it on in Settings.',
    );
    expect(res.key).not.toBe(IDEM);
  });

  it('keeps the unused key when the form is refused before any call', async () => {
    const res = await createLeadAction(empty, form({ title: '' }));
    expect(res.fieldErrors['title']).toBeTruthy();
    expect(res.key).toBe(IDEM);
    expect(api.createLead).not.toHaveBeenCalled();
  });

  it('replaces a missing or tampered key with a fresh one', async () => {
    api.createLead.mockResolvedValue({ id: LEAD });
    await expect(createLeadAction(empty, form({ idempotencyKey: 'x y' }))).rejects.toThrow();
    const sent = api.createLead.mock.calls[0]?.[2] as string;
    expect(sent).toMatch(GUID_SHAPE);
    expect(sent).not.toBe('x y');
  });
});

const apiError = (status: number, code: string) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678' },
  });

const convertForm = () => {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    leadId: LEAD,
    idempotencyKey: IDEM,
    customerMode: 'create',
    legalName: 'Himalayan Construction Pvt. Ltd.',
    opportunityName: 'Bridge works',
    expectedVersion: '3',
    line1: 'Balaju',
    city: 'Kathmandu',
    contactMode: 'create',
    contactName: 'Sita Rai',
    contactEmail: 'sita@himalayan.example',
  })) {
    f.set(k, v);
  }
  return f;
};

describe('convertLeadAction', () => {
  it.each([
    ['duplicate_pan_vat', 'Another customer already has this PAN/VAT number.'],
    ['primary_contact_exists', 'This customer already has a primary contact.'],
    ['kyb_not_verified', "This customer's verification must be approved first."],
  ])(
    'shows the real sentence for the 409 code %s, and does not ask for a reload',
    async (code, text) => {
      api.convertLead.mockRejectedValue(apiError(409, code));
      const res = await convertLeadAction(empty, convertForm());
      expect(res.error).toBe(text);
      expect(res.reload).toBe(false);
      expect(res.definite).toBe(true);
    },
  );

  it('puts a 422 contact_email_required next to the contact, not as a generic failure', async () => {
    api.convertLead.mockRejectedValue(apiError(422, 'contact_email_required'));
    const res = await convertLeadAction(empty, convertForm());
    expect(res.fieldErrors.contactId).toMatch(/no email/i);
    expect(res.error).toBeUndefined();
    expect(res.definite).toBe(true);
  });

  it('refuses a conversion without a contact before calling the API', async () => {
    const f = convertForm();
    f.delete('contactMode');
    const res = await convertLeadAction(empty, f);
    expect(res.fieldErrors.contactMode).toMatch(/choose a contact/i);
    expect(api.convertLead).not.toHaveBeenCalled();
  });
});

const ACTIVITY = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

function scheduleForm(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    subjectKind: 'leadId',
    subjectId: LEAD,
    kind: 'meeting',
    subject: '',
    dueAt: '2026-11-20T10:30',
    assigneeUserId: OWNER,
    body: 'Bring the revised scope.',
    idempotencyKey: IDEM,
    ...extra,
  })) {
    f.set(k, v);
  }
  return f;
}

describe('scheduleFollowUpAction', () => {
  it('sends a planned activity on the lead, subject defaulting to the kind, in Kathmandu time', async () => {
    api.createActivity.mockResolvedValue({ id: ACTIVITY });
    const res = await scheduleFollowUpAction(empty, scheduleForm());
    expect(api.createActivity).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        kind: 'meeting',
        subject: 'Meeting',
        body: 'Bring the revised scope.',
        dueAt: '2026-11-20T10:30:00+05:45',
        assigneeUserId: OWNER,
        leadId: LEAD,
      },
      IDEM,
    );
    expect(res.ok).toBe(true);
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(IDEM);
    expect(cache.revalidatePath).toHaveBeenCalledWith(`/leads/${LEAD}`);
    expect(cache.revalidatePath).toHaveBeenCalledWith('/activities');
  });

  it('refuses a note or a missing time next to the fields, without calling the API', async () => {
    const res = await scheduleFollowUpAction(empty, scheduleForm({ kind: 'note', dueAt: '' }));
    expect(res.fieldErrors['kind']).toMatch(/note records/i);
    expect(res.fieldErrors['dueAt']).toMatch(/when the follow-up is due/i);
    expect(res.values['body']).toBe('Bring the revised scope.');
    expect(res.key).toBe(IDEM);
    expect(api.createActivity).not.toHaveBeenCalled();
  });

  it('plans on an opportunity too (U16-Q6), and refuses any other subject', async () => {
    api.createActivity.mockResolvedValue({ id: 'a' });
    const ok = await scheduleFollowUpAction(empty, scheduleForm({ subjectKind: 'opportunityId' }));
    expect(ok.ok).toBe(true);
    expect(api.createActivity.mock.calls[0]?.[1]).toHaveProperty('opportunityId');
    expect(api.createActivity.mock.calls[0]?.[1]).not.toHaveProperty('leadId');

    api.createActivity.mockClear();
    const res = await scheduleFollowUpAction(empty, scheduleForm({ subjectKind: 'customerId' }));
    expect(res.error).toMatch(/incomplete/i);
    expect(api.createActivity).not.toHaveBeenCalled();
  });

  it('keeps the key after an unknown outcome, so the retry cannot plan it twice', async () => {
    api.createActivity.mockRejectedValueOnce(new ApiError(503, 'down'));
    const res = await scheduleFollowUpAction(empty, scheduleForm());
    expect(res.error).toBeTruthy();
    expect(res.key).toBe(IDEM);
  });
});

function changeForm(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    leadId: LEAD,
    activityId: ACTIVITY,
    expectedVersion: '4',
    ...extra,
  })) {
    f.set(k, v);
  }
  return f;
}

describe('follow-up changes', () => {
  it('completes with only the version, and refreshes the lead so it moves to History', async () => {
    api.completeActivity.mockResolvedValue({});
    const res = await completeFollowUpAction({}, changeForm());
    expect(res).toEqual({ ok: true });
    expect(api.completeActivity).toHaveBeenCalledExactlyOnceWith(expect.anything(), ACTIVITY, {
      expectedVersion: 4,
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith(`/leads/${LEAD}`);
  });

  it('reschedules to the new Kathmandu time and assignee', async () => {
    api.rescheduleActivity.mockResolvedValue({});
    const res = await rescheduleFollowUpAction(
      {},
      changeForm({ dueAt: '2026-12-01T09:00', assigneeUserId: OWNER }),
    );
    expect(res.ok).toBe(true);
    expect(api.rescheduleActivity).toHaveBeenCalledExactlyOnceWith(expect.anything(), ACTIVITY, {
      expectedVersion: 4,
      dueAt: '2026-12-01T09:00:00+05:45',
      assigneeUserId: OWNER,
    });
  });

  it('puts a missing new time on the field', async () => {
    const res = await rescheduleFollowUpAction({}, changeForm({ dueAt: '' }));
    expect(res.fieldErrors?.['dueAt']).toBe('Choose the new due time.');
    expect(api.rescheduleActivity).not.toHaveBeenCalled();
  });

  it('cancels with the version', async () => {
    api.cancelActivity.mockResolvedValue({});
    expect(await cancelFollowUpAction({}, changeForm())).toEqual({ ok: true });
    expect(api.cancelActivity).toHaveBeenCalledExactlyOnceWith(expect.anything(), ACTIVITY, {
      expectedVersion: 4,
    });
  });

  it('asks for a reload when the version is missing or the ids are not ids', async () => {
    const stale = await cancelFollowUpAction({}, changeForm({ expectedVersion: '' }));
    expect(stale.reload).toBe(true);
    expect(stale.error).toMatch(/reload/i);
    const tampered = await completeFollowUpAction({}, changeForm({ activityId: 'nope' }));
    expect(tampered.reload).toBe(true);
    expect(api.cancelActivity).not.toHaveBeenCalled();
    expect(api.completeActivity).not.toHaveBeenCalled();
  });

  it('says what the API refused and does not revalidate', async () => {
    api.completeActivity.mockRejectedValue(apiError(409, 'conflict'));
    const res = await completeFollowUpAction({}, changeForm());
    expect(res.ok).toBeUndefined();
    expect(res.error).toBeTruthy();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('follow-up changes on other subjects (migrated tasks)', () => {
  const OPP = '55555555-5555-4555-8555-555555555555';
  const subjectForm = (extra: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ activityId: ACTIVITY, expectedVersion: '4', ...extra })) {
      f.set(k, v);
    }
    return f;
  };

  it('completes, reschedules and cancels an opportunity follow-up, refreshing its page and /activities', async () => {
    api.completeActivity.mockResolvedValue({});
    api.rescheduleActivity.mockResolvedValue({});
    api.cancelActivity.mockResolvedValue({});
    const subject = { subjectKind: 'opportunityId', subjectId: OPP };

    expect(await completeFollowUpAction({}, subjectForm(subject))).toEqual({ ok: true });
    expect(
      (await rescheduleFollowUpAction({}, subjectForm({ ...subject, dueAt: '2026-12-01T09:00' })))
        .ok,
    ).toBe(true);
    expect(await cancelFollowUpAction({}, subjectForm(subject))).toEqual({ ok: true });

    expect(api.completeActivity).toHaveBeenCalledExactlyOnceWith(expect.anything(), ACTIVITY, {
      expectedVersion: 4,
    });
    expect(api.cancelActivity).toHaveBeenCalledOnce();
    expect(api.rescheduleActivity).toHaveBeenCalledOnce();
    const paths = new Set(cache.revalidatePath.mock.calls.map((c) => c[0] as string));
    expect(paths).toEqual(new Set([`/opportunities/${OPP}`, '/activities']));
  });

  it('refreshes a customer page for a customer task, and only /activities with no subject', async () => {
    api.completeActivity.mockResolvedValue({});
    await completeFollowUpAction({}, subjectForm({ subjectKind: 'customerId', subjectId: OPP }));
    expect(cache.revalidatePath.mock.calls.map((c) => c[0] as string)).toEqual([
      `/customers/${OPP}`,
      '/activities',
    ]);
    cache.revalidatePath.mockClear();
    expect(await completeFollowUpAction({}, subjectForm({}))).toEqual({ ok: true });
    expect(cache.revalidatePath.mock.calls.map((c) => c[0] as string)).toEqual(['/activities']);
  });

  it('builds the refreshed path itself: an unknown kind or a non-id is refused before any call', async () => {
    for (const bad of [
      { subjectKind: '/admin', subjectId: OPP },
      { subjectKind: 'opportunityId', subjectId: '../admin' },
      { subjectKind: 'opportunityId' },
      { leadId: 'nope' },
    ]) {
      const res = await completeFollowUpAction({}, subjectForm(bad));
      expect(res).toMatchObject({ reload: true });
    }
    expect(api.completeActivity).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

function ownerForm(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    leadId: LEAD,
    ownerUserId: OWNER,
    expectedVersion: '7',
    ...extra,
  })) {
    f.set(k, v);
  }
  return f;
}

describe('updateLeadOwnerAction', () => {
  it('sends only the new owner and the version, then refreshes the lead and the list', async () => {
    api.updateLead.mockResolvedValue({});
    expect(await updateLeadOwnerAction({}, ownerForm())).toEqual({ ok: true });
    expect(api.updateLead).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
      ownerUserId: OWNER,
      expectedVersion: 7,
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith(`/leads/${LEAD}`);
    expect(cache.revalidatePath).toHaveBeenCalledWith('/leads');
  });

  it('asks for a reload when the lead changed underneath the page (409)', async () => {
    api.updateLead.mockRejectedValue(apiError(409, 'conflict'));
    const res = await updateLeadOwnerAction({}, ownerForm());
    expect(res.reload).toBe(true);
    expect(res.error).toMatch(/reload/i);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it('says why the API refused a hand-over (403) without asking for a reload', async () => {
    api.updateLead.mockRejectedValue(apiError(403, 'forbidden'));
    const res = await updateLeadOwnerAction({}, ownerForm());
    expect(res.ok).toBeUndefined();
    expect(res.reload).toBe(false);
    expect(res.error).toBeTruthy();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it('puts a missing owner on the field and does not call the API', async () => {
    const res = await updateLeadOwnerAction({}, ownerForm({ ownerUserId: '' }));
    expect(res.fieldErrors?.['ownerUserId']).toBe('Choose who owns this lead.');
    expect(api.updateLead).not.toHaveBeenCalled();
  });

  it('asks for a reload when the version or the lead id is missing', async () => {
    const stale = await updateLeadOwnerAction({}, ownerForm({ expectedVersion: '' }));
    expect(stale.reload).toBe(true);
    expect(stale.error).toMatch(/reload/i);
    const tampered = await updateLeadOwnerAction({}, ownerForm({ leadId: 'nope' }));
    expect(tampered.reload).toBe(true);
    expect(api.updateLead).not.toHaveBeenCalled();
  });
});

describe('moveLeadStageAction with contactActivity', () => {
  const stageForm = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ recordId: LEAD, expectedVersion: '3', ...fields })) {
      f.set(k, v);
    }
    return f;
  };

  it('sends contactActivity to changeLeadStage when moving a new lead to contacted', async () => {
    api.changeLeadStage.mockResolvedValue({});
    const res = await moveLeadStageAction(
      {},
      stageForm({
        stage: 'contacted',
        contactKind: 'call',
        contactSubject: 'Discovery call',
        contactBody: 'Confirmed scope and timeline.',
      }),
    );
    expect(res).toEqual({ ok: true, movedTo: 'Contacted' });
    expect(api.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
      stage: 'contacted',
      expectedVersion: 3,
      contactActivity: {
        kind: 'call',
        subject: 'Discovery call',
        body: 'Confirmed scope and timeline.',
      },
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith('/leads');
    expect(cache.revalidatePath).toHaveBeenCalledWith(`/leads/${LEAD}`);
  });

  it('omits subject when left empty and returns contactBody field error when body is blank', async () => {
    api.changeLeadStage.mockResolvedValue({});
    const ok = await moveLeadStageAction(
      {},
      stageForm({
        stage: 'contacted',
        contactKind: 'email',
        contactSubject: '',
        contactBody: 'Sent introduction.',
      }),
    );
    expect(ok).toEqual({ ok: true, movedTo: 'Contacted' });
    expect(api.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
      stage: 'contacted',
      expectedVersion: 3,
      contactActivity: { kind: 'email', body: 'Sent introduction.' },
    });

    api.changeLeadStage.mockClear();
    const invalid = await moveLeadStageAction(
      {},
      stageForm({ stage: 'contacted', contactKind: 'call', contactBody: '   ' }),
    );
    expect(invalid.fieldErrors?.['contactBody']).toMatch(/call, email or meeting/i);
    expect(api.changeLeadStage).not.toHaveBeenCalled();
  });
});

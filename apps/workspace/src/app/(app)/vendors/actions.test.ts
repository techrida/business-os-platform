import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const api = vi.hoisted(() => ({
  createVendor: vi.fn(),
  createVendorContact: vi.fn(),
  findVendorNameMatches: vi.fn(),
  getVendor: vi.fn(),
  grantVendorPortalAccess: vi.fn(),
  proposeBankAccount: vi.fn(),
  rejectBankAccount: vi.fn(),
  submitVendorKyc: vi.fn(),
  updateVendor: vi.fn(),
  vendorLifecycle: vi.fn(),
  verifyBankAccount: vi.fn(),
}));
vi.mock('@/lib/api-vendors', () => api);

const {
  addContactAction,
  createVendorAction,
  decideBankAction,
  grantPortalAction,
  lifecycleAction,
  proposeBankAction,
  updateVendorAction,
} = await import('./actions');
const { panelStart } = await import('./_lib/state');

const ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const vendorForm = {
  idempotencyKey: KEY,
  legalName: 'Himal Traders Pvt. Ltd.',
  kind: 'company',
  pan: '301234567',
  'address.country': 'NP',
  vatRegistered: 'on',
};
const start = { key: KEY, errors: {} };

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['procurement'];
  api.findVendorNameMatches.mockResolvedValue([]);
});

describe('createVendorAction', () => {
  it('sends the contract body with the form key and goes to the new vendor', async () => {
    api.createVendor.mockResolvedValue({ id: ID });
    await expect(createVendorAction(start, form(vendorForm))).rejects.toThrow(
      `redirect /vendors/${ID}?created=1`,
    );
    expect(api.createVendor).toHaveBeenCalledWith(
      expect.anything(),
      {
        legalName: 'Himal Traders Pvt. Ltd.',
        kind: 'company',
        pan: '301234567',
        vatRegistered: true,
        country: 'NP',
      },
      KEY,
    );
  });

  // TR-Q12d: warn but allow.
  const namesake = { id: ACCOUNT, legalName: 'HIMAL TRADERS PVT LTD', status: 'blocked' as const };

  it('shows the vendors with the same name and creates nothing until the person confirms', async () => {
    api.findVendorNameMatches.mockResolvedValue([namesake]);
    const r = await createVendorAction(start, form(vendorForm));
    expect(api.findVendorNameMatches).toHaveBeenCalledWith(
      expect.anything(),
      'Himal Traders Pvt. Ltd.',
    );
    expect(r.sameName).toEqual([namesake]);
    expect(r.error).toBeUndefined();
    // Nothing was sent, so the same key goes with the confirmed submit.
    expect(r.key).toBe(KEY);
    expect(api.createVendor).not.toHaveBeenCalled();
  });

  it('adds the vendor once the person confirms the namesakes they were shown', async () => {
    api.findVendorNameMatches.mockResolvedValue([namesake]);
    api.createVendor.mockResolvedValue({ id: ID });
    await expect(
      createVendorAction(start, form({ ...vendorForm, sameNameConfirmed: ACCOUNT })),
    ).rejects.toThrow(`redirect /vendors/${ID}?created=1`);
    expect(api.createVendor).toHaveBeenCalledOnce();
  });

  it('warns again about a namesake the person has not seen, even after confirming another', async () => {
    const another = { id: DOC, legalName: 'Himal Traders', status: 'draft' as const };
    api.findVendorNameMatches.mockResolvedValue([namesake, another]);
    const r = await createVendorAction(start, form({ ...vendorForm, sameNameConfirmed: ACCOUNT }));
    expect(r.sameName).toEqual([namesake, another]);
    expect(api.createVendor).not.toHaveBeenCalled();
  });

  it('still adds the vendor when the name check cannot be read (it is a warning, not a gate)', async () => {
    api.findVendorNameMatches.mockRejectedValue(apiError(503, 'unavailable'));
    api.createVendor.mockResolvedValue({ id: ID });
    await expect(createVendorAction(start, form(vendorForm))).rejects.toThrow(
      `redirect /vendors/${ID}?created=1`,
    );
  });

  it('refuses without vendor.write and never calls the API', async () => {
    session.roles = ['accountant'];
    const r = await createVendorAction(start, form(vendorForm));
    expect(r.error).toMatch(/do not include adding vendors/);
    expect(api.createVendor).not.toHaveBeenCalled();
  });

  it('shows contract errors on the fields and keeps the key (nothing was sent)', async () => {
    const r = await createVendorAction(start, form({ ...vendorForm, pan: '12' }));
    expect(r.errors.pan).toMatch(/9 digits/);
    expect(r.key).toBe(KEY);
    expect(api.createVendor).not.toHaveBeenCalled();
  });

  it('a duplicate PAN (409) is final: it names vendors and rotates the key', async () => {
    api.createVendor.mockRejectedValue(apiError(409, 'duplicate_pan_vat'));
    const r = await createVendorAction(start, form(vendorForm));
    expect(r.error).toBe('Another vendor already has this PAN.');
    expect(r.key).not.toBe(KEY);
  });

  it('a 403 is final and rotates the key', async () => {
    api.createVendor.mockRejectedValue(apiError(403, 'forbidden', { reason: 'no_permission' }));
    const r = await createVendorAction(start, form(vendorForm));
    expect(r.error).toMatch(/do not allow/);
    expect(r.key).not.toBe(KEY);
  });

  it.each([
    ['a 500', apiError(500, 'internal')],
    ['a lost connection', new Error('fetch failed')],
    [
      'the in-progress 409',
      apiError(409, 'conflict', { message: 'A request with this Idempotency-Key is in progress' }),
    ],
  ])('keeps the same key after %s, so a retry replays the first request', async (_n, err) => {
    api.createVendor.mockRejectedValue(err);
    const r = await createVendorAction(start, form(vendorForm));
    expect(r.key).toBe(KEY);
    expect(r.error).toBeTruthy();
  });

  it('replaces a tampered key with a fresh one', async () => {
    api.createVendor.mockResolvedValue({ id: ID });
    await expect(
      createVendorAction(start, form({ ...vendorForm, idempotencyKey: 'x' })),
    ).rejects.toThrow('redirect');
    const sent = api.createVendor.mock.calls[0]?.[2] as string;
    expect(sent).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(sent).not.toBe('x');
  });
});

describe('updateVendorAction', () => {
  const original = {
    legalName: 'Himal Traders Pvt. Ltd.',
    kind: 'company',
    pan: '301234567',
    vatRegistered: false,
    status: 'draft',
    country: 'NP',
    address: null,
  };
  const fields = { vendorId: ID, expectedVersion: '3', ...vendorForm, vatRegistered: 'on' };

  it('sends only the change with the version the person saw', async () => {
    api.getVendor.mockResolvedValue(original);
    api.updateVendor.mockResolvedValue({});
    await expect(updateVendorAction(start, form(fields))).rejects.toThrow(
      `redirect /vendors/${ID}?saved=1`,
    );
    expect(api.updateVendor).toHaveBeenCalledWith(expect.anything(), ID, {
      expectedVersion: 3,
      vatRegistered: true,
    });
  });

  it('D10: sends the kind and country together, and the new PAN a switch to Nepal needs', async () => {
    api.getVendor.mockResolvedValue({ ...original, kind: 'foreign', country: 'IN', pan: null });
    api.updateVendor.mockResolvedValue({});
    const posted = {
      ...fields,
      kind: 'company',
      pan: '301234568',
      'address.country': 'NP',
      vatRegistered: '',
    };
    await expect(updateVendorAction(start, form(posted))).rejects.toThrow('redirect');
    expect(api.updateVendor).toHaveBeenCalledWith(expect.anything(), ID, {
      expectedVersion: 3,
      kind: 'company',
      country: 'NP',
      pan: '301234568',
    });
  });

  it('D10: a switch to Nepal without a PAN stops before the API and names the PAN', async () => {
    api.getVendor.mockResolvedValue({ ...original, kind: 'foreign', country: 'IN', pan: null });
    const r = await updateVendorAction(
      start,
      form({ ...fields, kind: 'company', pan: '', 'address.country': 'NP', vatRegistered: '' }),
    );
    expect(api.updateVendor).not.toHaveBeenCalled();
    expect(r.errors.pan).toMatch(/PAN is required/);
  });

  it('a save with nothing changed is a neutral notice, not an error (R6Q4)', async () => {
    api.getVendor.mockResolvedValue({ ...original, vatRegistered: true });
    const r = await updateVendorAction(start, form(fields));
    expect(api.updateVendor).not.toHaveBeenCalled();
    expect(r.error).toBeUndefined();
    expect(r.notice).toBe('Nothing changed, so there is nothing to save.');
  });

  it('a stale version (409) asks for a reload', async () => {
    api.getVendor.mockResolvedValue(original);
    api.updateVendor.mockRejectedValue(apiError(409, 'conflict'));
    const r = await updateVendorAction(start, form(fields));
    expect(r.reload).toBe(true);
    expect(r.error).toMatch(/changed since you opened/);
  });

  it('a locked identity (409) keeps its own sentence and no reload', async () => {
    api.getVendor.mockResolvedValue(original);
    api.updateVendor.mockRejectedValue(apiError(409, 'vendor_identity_locked'));
    const r = await updateVendorAction(start, form(fields));
    expect(r.error).toMatch(/cannot be edited/);
    expect(r.reload).toBeUndefined();
  });
});

describe('lifecycleAction', () => {
  const panel = panelStart(KEY);

  it('activate with no approved KYB case (409) is worded plainly', async () => {
    session.roles = ['founder'];
    api.vendorLifecycle.mockRejectedValue(apiError(409, 'kyb_not_verified'));
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'activate', idempotencyKey: KEY }),
    );
    expect(r.error).toMatch(/no approved KYB case/);
    expect(r.error).not.toMatch(/customer/i);
    expect(r.reload).toBeUndefined();
    expect(api.vendorLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      'activate',
      KEY,
      undefined,
    );
  });

  it('self-activation (403) tells the creator someone else must do it', async () => {
    session.roles = ['founder'];
    api.vendorLifecycle.mockRejectedValue(
      apiError(403, 'forbidden', { reason: 'separation_of_duties' }),
    );
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'activate', idempotencyKey: KEY }),
    );
    expect(r.error).toMatch(/You created this vendor, so someone else must activate it/);
    expect(r.key).not.toBe(KEY);
  });

  it('keeps the key after a 5xx on activate', async () => {
    session.roles = ['founder'];
    api.vendorLifecycle.mockRejectedValue(apiError(503, 'unavailable'));
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'activate', idempotencyKey: KEY }),
    );
    expect(r.key).toBe(KEY);
  });

  it('activating needs vendor.activate, not just vendor.write', async () => {
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'activate', idempotencyKey: KEY }),
    );
    expect(r.error).toMatch(/do not include approving vendors/);
    expect(api.vendorLifecycle).not.toHaveBeenCalled();
  });

  it('suspend asks for a reason before calling the API', async () => {
    session.roles = ['founder'];
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'suspend', reason: '  ', idempotencyKey: KEY }),
    );
    expect(r.errors.reason).toMatch(/Say why/);
    expect(api.vendorLifecycle).not.toHaveBeenCalled();
  });

  it('block sends the trimmed reason and rotates the key on success', async () => {
    session.roles = ['founder'];
    api.vendorLifecycle.mockResolvedValue({});
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'block', reason: ' Unpaid dues ', idempotencyKey: KEY }),
    );
    expect(api.vendorLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      'block',
      KEY,
      'Unpaid dues',
    );
    expect(r.saved).toMatch(/blocked/);
    expect(r.key).not.toBe(KEY);
    expect(r.savedCount).toBe(1);
  });

  it('start KYB review is open to vendor.write and sends the key and the status its button saw', async () => {
    api.submitVendorKyc.mockResolvedValue({});
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'submit_kyc', expectedStatus: 'draft', idempotencyKey: KEY }),
    );
    expect(api.submitVendorKyc).toHaveBeenCalledWith(expect.anything(), ID, KEY, 'draft');
    expect(r.saved).toBe('KYB review started.');
  });

  it('send for review says so', async () => {
    api.submitVendorKyc.mockResolvedValue({});
    const r = await lifecycleAction(
      panel,
      form({
        vendorId: ID,
        command: 'submit_kyc',
        expectedStatus: 'pending_kyc',
        idempotencyKey: KEY,
      }),
    );
    expect(api.submitVendorKyc).toHaveBeenCalledWith(expect.anything(), ID, KEY, 'pending_kyc');
    expect(r.saved).toBe('The vendor was sent for review.');
  });

  it('a KYB move without the status its button saw is an incomplete form, never sent', async () => {
    for (const expectedStatus of [undefined, 'approved', 'nope']) {
      const r = await lifecycleAction(
        panel,
        form({
          vendorId: ID,
          command: 'submit_kyc',
          idempotencyKey: KEY,
          ...(expectedStatus === undefined ? {} : { expectedStatus }),
        }),
      );
      expect(r.error).toMatch(/incomplete/);
    }
    expect(api.submitVendorKyc).not.toHaveBeenCalled();
  });

  it('a stale KYB button (409) is worded plainly and redraws the vendor page', async () => {
    const { revalidatePath } = await import('next/cache');
    api.submitVendorKyc.mockRejectedValue(apiError(409, 'conflict'));
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'submit_kyc', expectedStatus: 'draft', idempotencyKey: KEY }),
    );
    expect(r.error).toBe('This vendor changed since you opened it. Reload and try again.');
    expect(r.error).not.toMatch(/internal wording/);
    expect(r.reload).toBe(true);
    expect(r.refreshed).toBe(true);
    expect(r.saved).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith(`/vendors/${ID}`);
    // A definite answer: the next try is a new decision with a new key.
    expect(r.key).not.toBe(KEY);
  });

  it('a refusal that does not mean the page is stale leaves the page as it is', async () => {
    const { revalidatePath } = await import('next/cache');
    api.submitVendorKyc.mockRejectedValue(apiError(409, 'kyb_not_submitted'));
    const r = await lifecycleAction(
      panel,
      form({
        vendorId: ID,
        command: 'submit_kyc',
        expectedStatus: 'pending_kyc',
        idempotencyKey: KEY,
      }),
    );
    expect(r.error).toMatch(/KYB case has not been submitted/);
    expect(r.refreshed).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('an unknown command is refused as an incomplete form', async () => {
    const r = await lifecycleAction(
      panel,
      form({ vendorId: ID, command: 'delete', idempotencyKey: KEY }),
    );
    expect(r.error).toMatch(/incomplete/);
    expect(api.vendorLifecycle).not.toHaveBeenCalled();
  });
});

describe('bank accounts', () => {
  const panel = panelStart(KEY);

  it('propose strips spaces and shows the maker-checker note', async () => {
    api.proposeBankAccount.mockResolvedValue({});
    const r = await proposeBankAction(
      panelStart(KEY),
      form({
        vendorId: ID,
        idempotencyKey: KEY,
        bankName: 'Nabil Bank',
        accountName: 'Himal Traders',
        accountNumber: '0011 2233 4455',
      }),
    );
    expect(api.proposeBankAccount).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      { bankName: 'Nabil Bank', accountName: 'Himal Traders', accountNumber: '001122334455' },
      KEY,
    );
    expect(r.saved).toMatch(/different person must verify/);
    expect(JSON.stringify(r)).not.toContain('001122334455');
  });

  it('propose needs vendor.bank.propose', async () => {
    session.roles = ['accountant'];
    const r = await proposeBankAction(
      panelStart(KEY),
      form({
        vendorId: ID,
        idempotencyKey: KEY,
        bankName: 'N',
        accountName: 'H',
        accountNumber: '123456',
      }),
    );
    expect(r.error).toMatch(/do not include proposing/);
    expect(api.proposeBankAccount).not.toHaveBeenCalled();
  });

  it('the proposer verifying (403) is told they proposed it', async () => {
    session.roles = ['finance'];
    api.verifyBankAccount.mockRejectedValue(
      apiError(403, 'forbidden', { reason: 'separation_of_duties' }),
    );
    const r = await decideBankAction(
      panel,
      form({
        vendorId: ID,
        accountId: ACCOUNT,
        intent: 'verify',
        documentId: DOC,
        idempotencyKey: KEY,
      }),
    );
    expect(r.error).toMatch(/You proposed this bank account, so someone else must verify it/);
    expect(api.verifyBankAccount).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      ACCOUNT,
      { callbackEvidenceDocumentId: DOC },
      KEY,
    );
  });

  it('verify without evidence never calls the API', async () => {
    session.roles = ['finance'];
    const r = await decideBankAction(
      panel,
      form({ vendorId: ID, accountId: ACCOUNT, intent: 'verify', idempotencyKey: KEY }),
    );
    expect(r.errors.evidence).toMatch(/call-back evidence/);
    expect(api.verifyBankAccount).not.toHaveBeenCalled();
  });

  it('unclean evidence (409) asks for a clean upload', async () => {
    session.roles = ['finance'];
    api.verifyBankAccount.mockRejectedValue(apiError(409, 'callback_evidence_not_clean'));
    const r = await decideBankAction(
      panel,
      form({
        vendorId: ID,
        accountId: ACCOUNT,
        intent: 'verify',
        documentId: DOC,
        idempotencyKey: KEY,
      }),
    );
    expect(r.error).toMatch(/virus scan/);
  });

  it('verify and reject need vendor.bank.verify (procurement is refused)', async () => {
    const r = await decideBankAction(
      panel,
      form({
        vendorId: ID,
        accountId: ACCOUNT,
        intent: 'reject',
        reason: 'wrong name',
        idempotencyKey: KEY,
      }),
    );
    expect(r.error).toMatch(/do not include verifying/);
    expect(api.rejectBankAccount).not.toHaveBeenCalled();
  });

  it('reject needs a reason, then sends it', async () => {
    session.roles = ['finance'];
    const none = await decideBankAction(
      panel,
      form({ vendorId: ID, accountId: ACCOUNT, intent: 'reject', idempotencyKey: KEY }),
    );
    expect(none.errors.reason).toMatch(/Say why/);
    api.rejectBankAccount.mockResolvedValue({});
    const ok = await decideBankAction(
      panel,
      form({
        vendorId: ID,
        accountId: ACCOUNT,
        intent: 'reject',
        reason: 'wrong name',
        idempotencyKey: KEY,
      }),
    );
    expect(api.rejectBankAccount).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      ACCOUNT,
      { reason: 'wrong name' },
      KEY,
    );
    expect(ok.saved).toMatch(/rejected/);
  });
});

describe('contacts and portal access', () => {
  it('adds a contact and clears the form (savedCount rises)', async () => {
    api.createVendorContact.mockResolvedValue({});
    const r = await addContactAction(
      panelStart(KEY),
      form({
        vendorId: ID,
        idempotencyKey: KEY,
        name: 'Sita Sharma',
        email: 'sita@example.com',
        country: 'NP',
        'phones.0.country': 'NP',
        'phones.0.number': '+9779812345678',
        'phones.0.label': 'mobile',
        'phones.0.isPrimary': 'true',
        'phones.1.country': 'US',
        'phones.1.number': '+14155552671',
        'phones.1.label': '',
        'phones.1.isPrimary': 'false',
      }),
    );
    expect(api.createVendorContact).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      {
        name: 'Sita Sharma',
        email: 'sita@example.com',
        country: 'NP',
        phones: [
          { country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: true },
          { country: 'US', e164: '+14155552671', isPrimary: false },
        ],
        isPortalAdmin: false,
      },
      KEY,
    );
    expect(r.saved).toBe('Sita Sharma was added.');
    expect(r.savedCount).toBe(1);
  });

  it('portal grant for a vendor in the wrong status (409) asks for a reload', async () => {
    api.grantVendorPortalAccess.mockRejectedValue(apiError(409, 'invalid_transition'));
    const r = await grantPortalAction(
      panelStart(KEY),
      form({ vendorId: ID, contactId: DOC, idempotencyKey: KEY }),
    );
    expect(r.error).toMatch(/approved vendor/);
    expect(r.reload).toBe(true);
  });

  it('portal grant for a contact without an email says what to do', async () => {
    api.grantVendorPortalAccess.mockRejectedValue(apiError(400, 'contact_email_missing'));
    const r = await grantPortalAction(
      panelStart(KEY),
      form({ vendorId: ID, contactId: DOC, idempotencyKey: KEY }),
    );
    expect(r.error).toMatch(/no email address/);
  });

  it('portal grant needs a chosen contact and names the invitation on success', async () => {
    const none = await grantPortalAction(
      panelStart(KEY),
      form({ vendorId: ID, idempotencyKey: KEY }),
    );
    expect(none.errors.contactId).toMatch(/Choose which contact/);
    api.grantVendorPortalAccess.mockResolvedValue({ email: 'sita@example.com', inviteSent: true });
    const ok = await grantPortalAction(
      panelStart(KEY),
      form({ vendorId: ID, contactId: DOC, idempotencyKey: KEY }),
    );
    expect(ok.saved).toBe('Portal access granted. An invitation was sent to sita@example.com.');
    expect(api.grantVendorPortalAccess).toHaveBeenCalledWith(expect.anything(), ID, DOC, KEY);
  });
});

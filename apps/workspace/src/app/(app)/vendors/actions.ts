'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import {
  createVendor,
  createVendorContact,
  findVendorNameMatches,
  getVendor,
  grantVendorPortalAccess,
  proposeBankAccount,
  rejectBankAccount,
  submitVendorKyc,
  updateVendor,
  vendorLifecycle,
  verifyBankAccount,
} from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { vendorFailure, type VendorFailure, type VendorOp } from './_lib/failure';
import {
  parseContact,
  parseCreateVendor,
  parseProposeBank,
  parseReason,
  parseUpdateVendor,
  readContactValues,
  readVendorValues,
  type BankField,
  type ContactField,
} from './_lib/forms';
import type { LifecycleCommand } from './_lib/model';
import type { PanelState, VendorFormState } from './_lib/state';

/**
 * Server actions for the vendor screens. Each one asks `requireStaffSession` first, checks the
 * vendor permission it needs (deny by default: the API still decides every call), validates with
 * the contracts' schemas, and words any refusal for a person through `vendorFailure`. The browser
 * never sees the API URL or a token.
 *
 * Idempotency: every POST carries the key the form submitted. A definite answer (a 4xx) rotates
 * it, because the next try is a new decision. A timeout, a 5xx or the "still in progress" 409
 * keeps it, so the first request is replayed instead of a second one being made.
 */

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** The key the next try sends: fresh after a definite refusal, the same one otherwise. */
const nextKeyFor = (f: VendorFailure, key: string): string => (f.definite ? randomUUID() : key);

const noPermission = (what: string): string =>
  `Your roles do not include ${what}. Ask an administrator if you need to.`;

// ---------------------------------------------------------------------------------------------
// Create and edit
// ---------------------------------------------------------------------------------------------

export async function createVendorAction(
  _prev: VendorFormState,
  form: FormData,
): Promise<VendorFormState> {
  const session = await requireStaffSession('/vendors/new');
  const key = keyOf(form);
  if (!(await getPermissionCheck(session))('vendor.write')) {
    return { key, errors: {}, error: noPermission('adding vendors') };
  }
  const parsed = parseCreateVendor(readVendorValues(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  // TR-Q12d, warn but allow: a vendor whose name matches one already on file is added only after the
  // person confirms it is a different one. Checked again on every submit, so a namesake the person has
  // not seen (a changed name, or one added meanwhile) is shown before anything is created. The check is
  // advice: if it cannot be read the vendor is still added, and the API's audit trail names any namesake.
  const confirmed = new Set(text(form, 'sameNameConfirmed').split(',').filter(isGuid));
  const sameName = await findVendorNameMatches(session, parsed.data.legalName).catch(() => []);
  if (sameName.some((m) => !confirmed.has(m.id))) return { key, errors: {}, sameName };

  let id: string;
  try {
    id = (await createVendor(session, parsed.data, key)).id;
  } catch (err) {
    const f = vendorFailure(err, 'create');
    return { key: nextKeyFor(f, key), errors: {}, error: f.message };
  }
  revalidatePath('/vendors');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/vendors/${encodeURIComponent(id)}?created=1`);
}

export async function updateVendorAction(
  _prev: VendorFormState,
  form: FormData,
): Promise<VendorFormState> {
  const id = text(form, 'vendorId');
  const key = randomUUID();
  if (!isGuid(id)) return { key, errors: {}, error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/vendors/${id}/edit`);
  if (!(await getPermissionCheck(session))('vendor.write')) {
    return { key, errors: {}, error: noPermission('editing vendors') };
  }
  // The version the person was looking at. A different current version is the API's 409.
  const seen = Number(text(form, 'expectedVersion'));
  if (!Number.isInteger(seen) || seen < 1) {
    return { key, errors: {}, error: INCOMPLETE, reload: true };
  }

  let original;
  try {
    original = await getVendor(session, id);
  } catch (err) {
    return { key, errors: {}, error: vendorFailure(err, 'edit').message };
  }
  const parsed = parseUpdateVendor(readVendorValues(form), original, seen);
  if (!parsed.ok) {
    return 'nothingChanged' in parsed
      ? { key, errors: {}, notice: 'Nothing changed, so there is nothing to save.' }
      : { key, errors: parsed.errors };
  }

  try {
    await updateVendor(session, id, parsed.data);
  } catch (err) {
    const f = vendorFailure(err, 'edit');
    return { key, errors: {}, error: f.message, ...(f.reload ? { reload: true } : {}) };
  }
  revalidatePath('/vendors');
  revalidatePath(`/vendors/${id}`);
  redirect(`/vendors/${encodeURIComponent(id)}?saved=1`);
}

// ---------------------------------------------------------------------------------------------
// Panels on the detail page
// ---------------------------------------------------------------------------------------------

/** Shared opening of every panel action: the vendor id, the session, the key. */
async function open(
  form: FormData,
  prev: PanelState,
): Promise<
  | {
      ok: true;
      vendorId: string;
      session: Awaited<ReturnType<typeof requireStaffSession>>;
      key: string;
    }
  | { ok: false; state: PanelState }
> {
  const vendorId = text(form, 'vendorId');
  const key = keyOf(form);
  if (!isGuid(vendorId)) {
    return {
      ok: false,
      state: { savedCount: prev.savedCount, key, errors: {}, error: INCOMPLETE, reload: true },
    };
  }
  const session = await requireStaffSession(`/vendors/${vendorId}`);
  return { ok: true, vendorId, session, key };
}

function refused(prev: PanelState, key: string, f: VendorFailure): PanelState {
  return {
    key: nextKeyFor(f, key),
    errors: {},
    error: f.message,
    savedCount: prev.savedCount,
    ...(f.reload ? { reload: true } : {}),
  };
}

function done(prev: PanelState, saved: string): PanelState {
  return { key: randomUUID(), errors: {}, saved, savedCount: prev.savedCount + 1 };
}

export async function addContactAction(
  prev: PanelState<ContactField>,
  form: FormData,
): Promise<PanelState<ContactField>> {
  const o = await open(form, prev);
  if (!o.ok) return o.state;
  if (!(await getPermissionCheck(o.session))('vendor.write')) {
    return {
      savedCount: prev.savedCount,
      key: o.key,
      errors: {},
      error: noPermission('changing vendors'),
    };
  }
  const parsed = parseContact(readContactValues(form));
  if (!parsed.ok) return { savedCount: prev.savedCount, key: o.key, errors: parsed.errors };

  try {
    await createVendorContact(o.session, o.vendorId, parsed.data, o.key);
  } catch (err) {
    return refused(prev, o.key, vendorFailure(err, 'contact'));
  }
  revalidatePath(`/vendors/${o.vendorId}`);
  return done(prev, `${parsed.data.name} was added.`);
}

const COMMAND_OP: Record<LifecycleCommand, VendorOp> = {
  submit_kyc: 'submitKyc',
  activate: 'activate',
  suspend: 'lifecycle',
  block: 'lifecycle',
  archive: 'lifecycle',
};
/** The statuses a KYB button is drawn for, and what it did there. */
const KYC_DONE = {
  draft: 'KYB review started.',
  pending_kyc: 'The vendor was sent for review.',
} as const;
const isKycStatus = (v: string): v is keyof typeof KYC_DONE => Object.hasOwn(KYC_DONE, v);

const COMMAND_DONE: Record<LifecycleCommand, string> = {
  submit_kyc: KYC_DONE.draft,
  activate: 'The vendor is approved.',
  suspend: 'The vendor is suspended.',
  block: 'The vendor is blocked.',
  archive: 'The vendor is archived.',
};
const isCommand = (v: string): v is LifecycleCommand => Object.hasOwn(COMMAND_OP, v);

/** Start or send the KYB review (`vendor.write`), or approve, suspend, block, archive (`vendor.activate`). */
export async function lifecycleAction(prev: PanelState, form: FormData): Promise<PanelState> {
  const o = await open(form, prev);
  if (!o.ok) return o.state;
  const command = text(form, 'command');
  if (!isCommand(command))
    return { savedCount: prev.savedCount, key: o.key, errors: {}, error: INCOMPLETE, reload: true };

  const allowed = await getPermissionCheck(o.session);
  if (!(command === 'submit_kyc' ? allowed('vendor.write') : allowed('vendor.activate'))) {
    return {
      ...prev,
      key: o.key,
      errors: {},
      error: noPermission(command === 'submit_kyc' ? 'changing vendors' : 'approving vendors'),
    };
  }

  let reason: string | undefined;
  if (command === 'suspend' || command === 'block' || command === 'archive') {
    const r = parseReason(text(form, 'reason'));
    if (!r.ok) return { savedCount: prev.savedCount, key: o.key, errors: { reason: r.error } };
    reason = r.data;
  }

  // The status the KYB button was drawn for: the API refuses (409) once the vendor has moved on, so a stale
  // "Start KYB review" in a second tab never sends the vendor for review.
  let kycFrom: keyof typeof KYC_DONE | undefined;
  if (command === 'submit_kyc') {
    const expectedStatus = text(form, 'expectedStatus');
    if (!isKycStatus(expectedStatus)) {
      return {
        savedCount: prev.savedCount,
        key: o.key,
        errors: {},
        error: INCOMPLETE,
        reload: true,
      };
    }
    kycFrom = expectedStatus;
  }

  try {
    if (kycFrom !== undefined) await submitVendorKyc(o.session, o.vendorId, o.key, kycFrom);
    else if (command !== 'submit_kyc') {
      await vendorLifecycle(o.session, o.vendorId, command, o.key, reason);
    }
  } catch (err) {
    const f = vendorFailure(err, COMMAND_OP[command]);
    if (!f.reload) return refused(prev, o.key, f);
    // The page is out of date: redraw it with the vendor's current status and buttons.
    revalidatePath('/vendors');
    revalidatePath(`/vendors/${o.vendorId}`);
    return { ...refused(prev, o.key, f), refreshed: true };
  }
  revalidatePath('/vendors');
  revalidatePath(`/vendors/${o.vendorId}`);
  return done(prev, kycFrom !== undefined ? KYC_DONE[kycFrom] : COMMAND_DONE[command]);
}

export async function proposeBankAction(
  prev: PanelState<BankField>,
  form: FormData,
): Promise<PanelState<BankField>> {
  const o = await open(form, prev);
  if (!o.ok) return o.state;
  if (!(await getPermissionCheck(o.session))('vendor.bank.propose')) {
    return {
      savedCount: prev.savedCount,
      key: o.key,
      errors: {},
      error: noPermission('proposing bank accounts'),
    };
  }
  const parsed = parseProposeBank({
    bankName: text(form, 'bankName'),
    branch: text(form, 'branch'),
    accountName: text(form, 'accountName'),
    accountNumber: text(form, 'accountNumber'),
    swift: text(form, 'swift'),
  });
  if (!parsed.ok) return { savedCount: prev.savedCount, key: o.key, errors: parsed.errors };

  try {
    await proposeBankAccount(o.session, o.vendorId, parsed.data, o.key);
  } catch (err) {
    return refused(prev, o.key, vendorFailure(err, 'propose'));
  }
  revalidatePath(`/vendors/${o.vendorId}`);
  return done(
    prev,
    'The bank account was proposed. A different person must verify it before it can be paid.',
  );
}

/**
 * Verify (with the call-back evidence the browser uploaded first) or reject a proposed account.
 * The API refuses the proposer with 403 `separation_of_duties`; the screen cannot know who
 * proposed (the DTO has no proposer), so it shows the buttons to anyone with `vendor.bank.verify`
 * and words the refusal.
 */
export async function decideBankAction(prev: PanelState, form: FormData): Promise<PanelState> {
  const o = await open(form, prev);
  if (!o.ok) return o.state;
  const accountId = text(form, 'accountId');
  const intent = text(form, 'intent');
  if (!isGuid(accountId) || (intent !== 'verify' && intent !== 'reject')) {
    return { savedCount: prev.savedCount, key: o.key, errors: {}, error: INCOMPLETE, reload: true };
  }
  if (!(await getPermissionCheck(o.session))('vendor.bank.verify')) {
    return {
      savedCount: prev.savedCount,
      key: o.key,
      errors: {},
      error: noPermission('verifying bank accounts'),
    };
  }

  try {
    if (intent === 'verify') {
      const documentId = text(form, 'documentId');
      if (!isGuid(documentId)) {
        return {
          ...prev,
          key: o.key,
          errors: { evidence: 'Attach the call-back evidence before verifying.' },
        };
      }
      await verifyBankAccount(
        o.session,
        o.vendorId,
        accountId,
        { callbackEvidenceDocumentId: documentId },
        o.key,
      );
    } else {
      const r = parseReason(text(form, 'reason'));
      if (!r.ok) return { savedCount: prev.savedCount, key: o.key, errors: { reason: r.error } };
      await rejectBankAccount(o.session, o.vendorId, accountId, { reason: r.data }, o.key);
    }
  } catch (err) {
    return refused(prev, o.key, vendorFailure(err, intent));
  }
  revalidatePath(`/vendors/${o.vendorId}`);
  return done(
    prev,
    intent === 'verify'
      ? 'The bank account is verified and active.'
      : 'The bank account was rejected.',
  );
}

export async function grantPortalAction(prev: PanelState, form: FormData): Promise<PanelState> {
  const o = await open(form, prev);
  if (!o.ok) return o.state;
  if (!(await getPermissionCheck(o.session))('vendor.write')) {
    return {
      savedCount: prev.savedCount,
      key: o.key,
      errors: {},
      error: noPermission('changing vendors'),
    };
  }
  const contactId = text(form, 'contactId');
  if (!isGuid(contactId)) {
    return {
      savedCount: prev.savedCount,
      key: o.key,
      errors: { contactId: 'Choose which contact gets portal access.' },
    };
  }
  try {
    const granted = await grantVendorPortalAccess(o.session, o.vendorId, contactId, o.key);
    revalidatePath(`/vendors/${o.vendorId}`);
    return done(
      prev,
      granted.inviteSent
        ? `Portal access granted. An invitation was sent to ${granted.email}.`
        : `Portal access granted to ${granted.email}. No invitation email was sent.`,
    );
  } catch (err) {
    return refused(prev, o.key, vendorFailure(err, 'grant'));
  }
}

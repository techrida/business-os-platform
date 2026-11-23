'use client';

import type { CountryCode, PartyPhoneInput, VendorStatus } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import {
  useActionState,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox-model';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { CountrySelect } from '@/components/ui/country-select';
import { Field, Input, Textarea } from '@/components/ui/field';
import fieldStyles from '@/components/ui/field.module.css';
import { PhoneListInput, type PhoneRowProblem } from '@/components/ui/phone-list-input';
import { toast } from '@/components/ui/toast';
import { formatBytes, guessMime } from '@/lib/kernel-ui';

import {
  addContactAction,
  decideBankAction,
  grantPortalAction,
  lifecycleAction,
  proposeBankAction,
} from '../actions';
import { EMPTY_BANK_VALUES, type BankField, type ContactField } from '../_lib/forms';
import type { LifecycleOption } from '../_lib/model';
import { panelStart, type PanelState } from '../_lib/state';
import styles from '../vendors.module.css';

/**
 * The small forms on the vendor detail page. Each is a Client Component only so a refusal shows
 * next to its button and the Idempotency-Key stays honest: the page makes a UUID per render, the
 * action returns the key the next submit must use (kept after a timeout, rotated after a 4xx).
 * Inputs are controlled so a refusal does not wipe what was typed.
 */

/** Refusal and confirmation for one form. The alert takes focus so a keyboard user lands on it. */
function Notice({
  state,
  reloadHref,
  title,
  announce = true,
}: {
  state: PanelState;
  reloadHref: string;
  title: string;
  /** False when the action itself toasts, because a success can unmount this form. */
  announce?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error) ref.current?.focus();
    if (announce && state.saved) toast.success(state.saved);
  }, [state, announce]);
  return state.error ? (
    <Alert
      ref={ref}
      tabIndex={-1}
      tone="error"
      role="alert"
      title={title}
      actions={state.reload ? <a href={reloadHref}>Reload this vendor</a> : null}
    >
      {state.error}
    </Alert>
  ) : null;
}

// ---------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------

export function ContactForm({
  vendorId,
  vendorCountry,
  idempotencyKey,
  initialName,
  onAdded,
  onCancel,
}: {
  vendorId: string;
  /** A new contact starts in the vendor's country; the person can pick another. */
  vendorCountry: CountryCode;
  idempotencyKey: string;
  /** Fills Name when the form opens from a picker's `Create "<typed>"`. */
  initialName?: string;
  /** Called once the contact is saved, so a form that opened this one can step back to its own fields. */
  onAdded?: () => void;
  /** Adds a Cancel button that goes back to wherever this form was opened from. */
  onCancel?: () => void;
}) {
  const [state, formAction, pending] = useActionState<PanelState<ContactField>, FormData>(
    addContactAction,
    panelStart<ContactField>(idempotencyKey),
  );
  const notifyAdded = useEffectEvent(() => onAdded?.());
  useEffect(() => {
    if (state.savedCount > 0) notifyAdded();
  }, [state.savedCount]);
  return (
    <form action={formAction} noValidate className={styles.panelForm}>
      <input type="hidden" name="vendorId" value={vendorId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <Notice state={state} reloadHref={`/vendors/${vendorId}`} title="Contact not saved" />
      <ContactFields
        key={state.savedCount}
        errors={state.errors}
        vendorCountry={vendorCountry}
        initialName={initialName ?? ''}
      />
      <div className={styles.actions}>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving' : 'Add contact'}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

const PHONES_UNFINISHED = 'Finish or remove the phone number marked below.';

function ContactFields({
  errors,
  vendorCountry,
  initialName,
}: {
  errors: PanelState<ContactField>['errors'];
  vendorCountry: CountryCode;
  initialName: string;
}) {
  const [v, setV] = useState({ name: initialName, email: '', role: '', isPortalAdmin: false });
  const [country, setCountry] = useState<CountryCode>(vendorCountry);
  // The valid numbers so far. They are the list's `defaultValue`, so the reset React runs after a refused
  // submit puts them back instead of wiping them; a save remounts this block (keyed on `savedCount`).
  const [phones, setPhones] = useState<PartyPhoneInput[]>([]);
  const problems = useRef<PhoneRowProblem[]>([]);
  const [unfinished, setUnfinished] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const phonesLabel = useId();
  const set =
    (field: 'name' | 'email' | 'role') =>
    (e: { target: { value: string } }): void =>
      setV((x) => ({ ...x, [field]: e.target.value }));

  // A row with an unfinished or wrong number stops the submit here (capture phase, before the action runs),
  // with the list's error, and focus goes to that row.
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    if (!form) return;
    const listener = (event: Event) => {
      if (event.defaultPrevented || problems.current.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setUnfinished(true);
      rootRef.current
        ?.querySelector<HTMLElement>(
          `[data-row="${problems.current[0]?.key}"] input[inputmode="tel"]`,
        )
        ?.focus();
    };
    form.addEventListener('submit', listener, true);
    return () => form.removeEventListener('submit', listener, true);
  }, []);

  return (
    <>
      <div ref={rootRef} className={styles.grid}>
        <Field label="Name" error={errors.name}>
          {(c) => (
            <Input
              name="name"
              value={v.name}
              onChange={set('name')}
              maxLength={120}
              required
              {...c}
            />
          )}
        </Field>
        <Field label="Role" optional error={errors.role}>
          {(c) => (
            <Input
              name="role"
              value={v.role}
              onChange={set('role')}
              maxLength={80}
              placeholder="Accounts"
              {...c}
            />
          )}
        </Field>
        <Field
          label="Email"
          optional
          hint="Needed if this person will get portal access."
          error={errors.email}
        >
          {(c) => (
            <Input
              type="email"
              name="email"
              value={v.email}
              onChange={set('email')}
              maxLength={254}
              autoComplete="off"
              {...c}
            />
          )}
        </Field>
        <Field
          label="Country"
          hint="Where this person is. It can differ from the vendor’s."
          error={errors.country}
        >
          {(c) => (
            <CountrySelect
              id={c.id}
              aria-labelledby={c['aria-labelledby']}
              aria-describedby={c['aria-describedby']}
              aria-invalid={c['aria-invalid']}
              name="country"
              required
              value={country}
              onChange={setCountry}
            />
          )}
        </Field>
        <div className={styles.wide}>
          <div className={fieldStyles.labelRow}>
            <span id={phonesLabel} className={fieldStyles.label}>
              Phone numbers
            </span>
            <span className={fieldStyles.optional}>Optional</span>
          </div>
          <PhoneListInput
            name="phones"
            aria-labelledby={phonesLabel}
            defaultValue={phones}
            defaultCountry={country}
            showLabels
            onChange={setPhones}
            onValidityChange={(next) => {
              problems.current = next;
              if (next.length === 0) setUnfinished(false);
            }}
            error={errors.phones ?? (unfinished ? PHONES_UNFINISHED : undefined)}
          />
        </div>
      </div>
      <label className={styles.check}>
        <input
          type="checkbox"
          name="isPortalAdmin"
          checked={v.isPortalAdmin}
          onChange={(e) => setV((x) => ({ ...x, isPortalAdmin: e.target.checked }))}
        />
        Marks this person as the vendor’s portal administrator
      </label>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/**
 * A lifecycle command changes which commands the page offers, so a success usually unmounts the
 * form that sent it. The toast is raised here, where the result arrives, not from an effect.
 */
function useLifecycle(idempotencyKey: string, onSaved?: () => void) {
  const [state, formAction, pending] = useActionState<PanelState, FormData>(async (prev, form) => {
    const next = await lifecycleAction(prev, form);
    if (next.saved) {
      toast.success(next.saved);
      onSaved?.();
    } else if (next.refreshed && next.error) {
      // A stale button: the page now shows the vendor's current status, and this dialog's button may be gone.
      toast.error(next.error);
      onSaved?.();
    }
    return next;
  }, panelStart(idempotencyKey));
  const [reason, setReason] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.errors.reason) {
      formRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }
  }, [state]);
  return { state, formAction, pending, reason, setReason, formRef };
}

function ReasonField({
  error,
  hint,
  reason,
  setReason,
}: {
  error: string | undefined;
  hint: string | undefined;
  reason: string;
  setReason: (value: string) => void;
}) {
  return (
    <Field label="Reason" hint={hint} error={error}>
      {(c) => (
        <Textarea
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={2}
          required
          {...c}
        />
      )}
    </Field>
  );
}

/** Every lifecycle action confirms in a fixed-footer dialog (UIP-DLG-001) with toast feedback. */
export function LifecycleForm({
  vendorId,
  status,
  option,
  idempotencyKey,
}: {
  vendorId: string;
  /** The vendor's status this button was drawn for; the API refuses a KYB move from any other. */
  status: VendorStatus;
  option: LifecycleOption;
  idempotencyKey: string;
}) {
  const [open, setOpen] = useState(false);
  // On success the action has toasted and revalidated the page; close over the new status.
  const { state, formAction, pending, reason, setReason, formRef } = useLifecycle(
    idempotencyKey,
    () => setOpen(false),
  );
  const formId = useId();
  const destructive = option.command === 'block' || option.command === 'archive';
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant={option.tone}>{option.label}</Button>}
      title={`${option.label}?`}
      description={option.help}
      size="small"
      tone={destructive ? 'destructive' : 'default'}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? 'Working' : option.label}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} action={formAction} noValidate className={styles.lifecycle}>
        <input type="hidden" name="vendorId" value={vendorId} />
        <input type="hidden" name="command" value={option.command} />
        <input type="hidden" name="expectedStatus" value={status} />
        <input type="hidden" name="idempotencyKey" value={state.key} />
        <Notice
          state={state}
          reloadHref={`/vendors/${vendorId}`}
          title="Nothing changed"
          announce={false}
        />
        {option.needsReason ? (
          <ReasonField
            error={state.errors.reason}
            hint={undefined}
            reason={reason}
            setReason={setReason}
          />
        ) : null}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------------------------

export function ProposeBankForm({
  vendorId,
  idempotencyKey,
}: {
  vendorId: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState<PanelState<BankField>, FormData>(
    proposeBankAction,
    panelStart<BankField>(idempotencyKey),
  );
  return (
    <form action={formAction} noValidate className={styles.panelForm}>
      <input type="hidden" name="vendorId" value={vendorId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <Notice state={state} reloadHref={`/vendors/${vendorId}`} title="Bank account not proposed" />
      <BankFields key={state.savedCount} errors={state.errors} />
      <p className={styles.note}>
        The number is stored encrypted and shown as its last four characters only. A different
        person verifies the account after a call-back to the bank, and attaches the evidence then.
      </p>
      <div className={styles.actions}>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving' : 'Propose bank account'}
        </Button>
      </div>
    </form>
  );
}

function BankFields({ errors }: { errors: PanelState<BankField>['errors'] }) {
  const [v, setV] = useState(EMPTY_BANK_VALUES);
  const set =
    (field: BankField) =>
    (e: { target: { value: string } }): void =>
      setV((x) => ({ ...x, [field]: e.target.value }));
  return (
    <div className={styles.grid}>
      <Field label="Bank" error={errors.bankName}>
        {(c) => (
          <Input
            name="bankName"
            value={v.bankName}
            onChange={set('bankName')}
            maxLength={120}
            required
            {...c}
          />
        )}
      </Field>
      <Field label="Branch" optional error={errors.branch}>
        {(c) => (
          <Input name="branch" value={v.branch} onChange={set('branch')} maxLength={120} {...c} />
        )}
      </Field>
      <Field label="Account name" error={errors.accountName}>
        {(c) => (
          <Input
            name="accountName"
            value={v.accountName}
            onChange={set('accountName')}
            maxLength={160}
            placeholder="As held at the bank"
            required
            {...c}
          />
        )}
      </Field>
      <Field label="Account number" error={errors.accountNumber}>
        {(c) => (
          <Input
            name="accountNumber"
            value={v.accountNumber}
            onChange={set('accountNumber')}
            maxLength={50}
            placeholder="0012 3456 7890"
            autoComplete="off"
            spellCheck={false}
            className={styles.numeric}
            required
            {...c}
          />
        )}
      </Field>
      <Field label="SWIFT code" optional error={errors.swift}>
        {(c) => (
          <Input
            name="swift"
            value={v.swift}
            onChange={set('swift')}
            maxLength={11}
            placeholder="NABILNPKA"
            autoComplete="off"
            spellCheck={false}
            {...c}
          />
        )}
      </Field>
    </div>
  );
}

interface Problem {
  message: string;
  reload: boolean;
}

/**
 * Verify or reject one proposed account. Verify uploads the call-back evidence first (to the
 * account's own route, raw file as the body), then sends its document id. A retry after a failed
 * verify does not upload the file again. Reject asks for a reason.
 */
export function BankDecision({
  vendorId,
  accountId,
  verifyKey,
  rejectKey,
  maxBytes,
  allowedMime,
}: {
  vendorId: string;
  accountId: string;
  verifyKey: string;
  rejectKey: string;
  maxBytes: number;
  allowedMime: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'verifying'>('idle');
  const [key, setKey] = useState(verifyKey);
  const [uploaded, setUploaded] = useState<{
    documentId: string;
    name: string;
    size: number;
  } | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [problem, setProblem] = useState<Problem | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectState, rejectAction, rejectPending] = useActionState<PanelState, FormData>(
    decideBankAction,
    panelStart(rejectKey),
  );
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (problem) summaryRef.current?.focus();
  }, [problem]);

  async function upload(file: File, mime: string): Promise<string | null> {
    setBusy('uploading');
    try {
      const res = await fetch(
        `/vendors/${encodeURIComponent(vendorId)}/bank-accounts/${encodeURIComponent(accountId)}/evidence`,
        {
          method: 'POST',
          headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(file.name) },
          body: file,
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        documentId?: string;
        error?: { message?: string };
      };
      if (res.status === 401) {
        // /auth/login is a Route Handler, not a page: it needs a real navigation.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(`/vendors/${vendorId}`)}`;
        return null;
      }
      if (!res.ok || typeof data.documentId !== 'string') {
        setProblem({
          message: data.error?.message ?? 'The upload did not finish. Try again.',
          reload: false,
        });
        return null;
      }
      setUploaded({ documentId: data.documentId, name: file.name, size: file.size });
      return data.documentId;
    } catch {
      setProblem({
        message: 'The upload was interrupted. Check your connection and try again.',
        reload: false,
      });
      return null;
    }
  }

  async function onVerify() {
    if (busy !== 'idle') return;
    const file = fileRef.current?.files?.[0];
    setProblem(null);
    const mime = file ? guessMime(file.name, file.type) : '';
    let error: string | undefined;
    if (!file) error = 'Choose the call-back evidence to attach.';
    else if (file.size === 0) error = 'That file is empty.';
    else if (file.size > maxBytes) {
      error = `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes)}.`;
    } else if (!allowedMime.includes(mime)) {
      error =
        'That file type is not accepted. Use PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV.';
    }
    setFileError(error);
    if (error !== undefined || !file) {
      fileRef.current?.focus();
      return;
    }

    let documentId =
      uploaded !== null && uploaded.name === file.name && uploaded.size === file.size
        ? uploaded.documentId
        : null;
    if (documentId === null) {
      documentId = await upload(file, mime);
      if (documentId === null) return setBusy('idle');
    }

    setBusy('verifying');
    const form = new FormData();
    form.set('vendorId', vendorId);
    form.set('accountId', accountId);
    form.set('intent', 'verify');
    form.set('documentId', documentId);
    form.set('idempotencyKey', key);
    try {
      const res = await decideBankAction(panelStart(key), form);
      setKey(res.key);
      if (res.error !== undefined || res.errors.evidence !== undefined) {
        setProblem({
          message: res.error ?? res.errors.evidence ?? 'The account was not verified.',
          reload: res.reload === true,
        });
        // The API said the evidence is not usable: the next try uploads a fresh file.
        if (res.error?.includes('virus scan')) setUploaded(null);
        return;
      }
      toast.success(res.saved ?? 'The bank account is verified.');
      setUploaded(null);
      router.refresh();
    } catch {
      // The call may or may not have landed: the key stays, so the retry names the same request.
      setProblem({
        message:
          'We could not tell whether the account was verified. Try again; your file is already uploaded.',
        reload: false,
      });
    } finally {
      setBusy('idle');
    }
  }

  return (
    <div className={styles.decide}>
      <Field
        label="Call-back evidence"
        hint={`A note or scan of the call to the bank. PDF, image or Office file up to ${formatBytes(maxBytes)}; it is virus-scanned first.`}
        error={fileError}
      >
        {(c) => (
          <input
            ref={fileRef}
            name="file"
            type="file"
            className={styles.fileInput}
            accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.pptx,.csv"
            disabled={busy !== 'idle'}
            onChange={() => setFileError(undefined)}
            {...c}
          />
        )}
      </Field>

      {problem ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title="Not verified"
          actions={problem.reload ? <a href={`/vendors/${vendorId}`}>Reload this vendor</a> : null}
        >
          {problem.message}
        </Alert>
      ) : null}
      <div className={styles.decideButtons}>
        <Button type="button" disabled={busy !== 'idle'} onClick={() => void onVerify()}>
          {busy === 'uploading'
            ? 'Uploading'
            : busy === 'verifying'
              ? 'Verifying'
              : 'Verify account'}
        </Button>
        {!rejecting ? (
          <Button type="button" variant="secondary" onClick={() => setRejecting(true)}>
            Reject account
          </Button>
        ) : null}
      </div>
      <p className={styles.status} role="status">
        {busy === 'uploading'
          ? 'Uploading the evidence'
          : busy === 'verifying'
            ? 'Verifying the account'
            : ''}
      </p>

      {rejecting ? (
        <form action={rejectAction} noValidate className={styles.panelForm}>
          <input type="hidden" name="vendorId" value={vendorId} />
          <input type="hidden" name="accountId" value={accountId} />
          <input type="hidden" name="intent" value="reject" />
          <input type="hidden" name="idempotencyKey" value={rejectState.key} />
          <Notice state={rejectState} reloadHref={`/vendors/${vendorId}`} title="Not rejected" />
          <Field label="Reason for rejecting" error={rejectState.errors.reason}>
            {(c) => (
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                required
                {...c}
              />
            )}
          </Field>
          <div className={styles.decideButtons}>
            <Button type="submit" variant="secondary" disabled={rejectPending}>
              {rejectPending ? 'Rejecting' : 'Reject account'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Portal access
// ---------------------------------------------------------------------------------------------

export interface PortalContactOption {
  id: string;
  label: string;
  /** Shown beside the name; the invitation goes here. */
  email: string | null;
  /** A contact without an email cannot be invited. */
  hasEmail: boolean;
}

/**
 * Pick the contact who gets portal access: one search-as-you-type box, the email beside each name. When nobody
 * matches (or the person is new), the last row is `Create "<typed>"`: it swaps this form for the add-contact
 * fields with that name filled in, and a saved contact brings the picker back with them in the list.
 */
export function PortalForm({
  vendorId,
  vendorCountry,
  contacts,
  idempotencyKey,
  addContactKey,
}: {
  vendorId: string;
  /** A contact created from the picker starts in the vendor's country. */
  vendorCountry: CountryCode;
  contacts: PortalContactOption[];
  idempotencyKey: string;
  /** The Idempotency-Key for the add-contact form this picker can open. */
  addContactKey: string;
}) {
  const [state, formAction, pending] = useActionState<PanelState, FormData>(
    grantPortalAction,
    panelStart(idempotencyKey),
  );
  const [choice, setChoice] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const options = useMemo<ComboboxOption[]>(
    () =>
      contacts.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.email ?? 'No email',
        disabled: !o.hasEmail,
        disabledReason: 'Add an email to this contact to invite them',
      })),
    [contacts],
  );
  if (creating !== null) {
    return (
      <ContactForm
        vendorId={vendorId}
        vendorCountry={vendorCountry}
        idempotencyKey={addContactKey}
        initialName={creating}
        onAdded={() => setCreating(null)}
        onCancel={() => setCreating(null)}
      />
    );
  }
  return (
    <form action={formAction} noValidate className={styles.panelForm}>
      <input type="hidden" name="vendorId" value={vendorId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <Notice state={state} reloadHref={`/vendors/${vendorId}`} title="Portal access not granted" />
      <Field
        label="Contact"
        hint="This person gets an invitation to the vendor portal and becomes its administrator."
        error={state.errors.contactId}
      >
        {(c) => (
          <Combobox
            id={c.id}
            name="contactId"
            labelledBy={c['aria-labelledby']}
            describedBy={c['aria-describedby']}
            invalid={c['aria-invalid'] === true}
            searchIcon
            keepOrder
            // Contacts have no group: a long list stays flat instead of showing an "Unassigned" header.
            groupThreshold={Number.POSITIVE_INFINITY}
            options={options}
            value={choice}
            onChange={setChoice}
            open={open}
            onOpenChange={setOpen}
            placeholder="Search by name or email"
            emptyText="No contacts yet. Type a name to add one."
            noMatchText="No contact matches."
            addOption={{
              always: true,
              label: (text) => `Create "${text}"`,
              onAdd: (text) => setCreating(text),
            }}
          />
        )}
      </Field>
      <div className={styles.actions}>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Granting' : 'Grant portal access'}
        </Button>
      </div>
    </form>
  );
}

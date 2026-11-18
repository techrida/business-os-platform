'use client';
import type { MemoDirectory, MemoTemplateSnapshot } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import { memoPdfInputOf } from '@/lib/memo-pdf-input';
import type { MemoDraftValues } from '@/lib/memo-working-draft-types';

import styles from '../kit.module.css';
import type { MemoFormState, MemoValues } from './actions';
import { ConflictDialog, SaveState } from './draft-status';
import { discardSavedMemo } from './draft-transport';
import { keyOf } from './draft-sync';
import { DownloadIcon, PrintIcon, TrashIcon } from './memo-icons';
import {
  buildPreviewTemplate,
  draftValuesOf,
  initialTemplateFields,
  restoreFromDraft,
  templateInputOf,
  type TemplateFields,
} from './memo-form-model';
import type { PdfSource } from './memo-pdf-client';
import { MemoPreview } from './memo-preview';
import { useMemoReviewGate } from './memo-review-gate';
import templateStyles from './memo-template.module.css';
import { SignerSection } from './signer-section';
import { useMemoDraftSync } from './use-memo-draft-sync';
import { useMemoPdfActions } from './use-memo-pdf-actions';

const CURRENCY_OPTIONS = [
  { value: 'NPR', label: 'NPR (Nepalese rupee)' },
  { value: 'INR', label: 'INR (Indian rupee)' },
  { value: 'USD', label: 'USD (US dollar)' },
];

const NO_SOURCE: PdfSource = { kind: 'saved', memoId: '' };

/**
 * The memo create and edit form. One component for both, because they share fields and rules; the
 * server action passed in decides what happens on submit. Inputs are controlled so a refusal does
 * not wipe what was typed (React 19 resets uncontrolled fields after every action), and so the paper
 * beside the form is a pure function of the same values: every keystroke reaches it.
 *
 * Autosave: while the person types, a working copy is kept on the server for their account (see
 * use-memo-draft-sync.ts), so a refresh or a later sign-in finds it again. The footer's primary button is
 * the next real step ("Next" creates the memo and opens the attachments step; "Done" saves an edit); there is no
 * separate "Save draft".
 */
export function MemoForm(props: MemoFormProps) {
  const router = useRouter();
  const [epoch, setEpoch] = useState(0);
  const [navigating, startNavigation] = useTransition();
  const wasNavigating = useRef(false);
  // After Done the page shows the saved memo in the same route. The form is rebuilt once that page has arrived (new
  // baseline, autosave running again, header Submit released), whatever the saved text turned out to be.
  useEffect(() => {
    if (wasNavigating.current && !navigating) setEpoch((n) => n + 1);
    wasNavigating.current = navigating;
  }, [navigating]);
  const onSaved = useCallback((to: string) => startNavigation(() => router.push(to)), [router]);
  // A server re-render with different saved content (a change made elsewhere) also starts a fresh form. Typing in
  // progress is written out by the old form as it unmounts.
  const contentKey = JSON.stringify([
    props.memoId ?? null,
    props.initial,
    props.template ?? null,
    epoch,
  ]);
  return <MemoFormInner key={contentKey} {...props} onSaved={onSaved} />;
}

interface MemoFormProps {
  action: (prev: MemoFormState, form: FormData) => Promise<MemoFormState>;
  initial: MemoValues;
  directory?: MemoDirectory | undefined;
  template?: MemoTemplateSnapshot | null | undefined;
  /** The primary button's text. Default: "Next" for a new memo, "Done" for an edit. */
  submitLabel?: string;
  memoId?: string;
  memoVersion?: number;
  /**
   * The opaque account binding the server rendered this page with (`memoDraftAccount(session)`). It guards the
   * autosave routes and the server action against a tab left open from another account. Without it there is no
   * autosave, and the server action refuses the submit.
   */
  draftAccount?: string | undefined;
  /** Shows the Delete draft button. A saved memo that can no longer be discarded passes false. */
  canDiscard?: boolean;
  /** @deprecated The footer has no Cancel any more (Delete draft replaces it). Accepted so older callers compile. */
  cancelHref?: string;
}

function MemoFormInner({
  action,
  initial,
  submitLabel,
  memoId,
  memoVersion,
  directory,
  template,
  draftAccount,
  canDiscard = true,
  onSaved,
}: MemoFormProps & { onSaved: (to: string) => void }) {
  const router = useRouter();
  const [initialState] = useState<MemoFormState>(() => ({ values: initial, fieldErrors: {} }));
  const [values, setValues] = useState<MemoValues>(initial);
  const [fields, setFields] = useState<TemplateFields>(() =>
    initialTemplateFields(template, directory),
  );
  const summaryRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const departmentRef = useRef<HTMLSelectElement>(null);
  const paperId = useId();

  const set = (key: keyof MemoValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const setField =
    <K extends keyof TemplateFields>(key: K) =>
    (value: TemplateFields[K]) =>
      setFields((f) => ({ ...f, [key]: value }));

  // Preserve saved attribution; a different editor must not silently become the preparer.
  const preparedBy = template?.preparedBy.userId ?? directory?.currentUserId ?? '';
  const preview = directory ? buildPreviewTemplate(directory, template, fields, preparedBy) : null;
  const templateInput = templateInputOf(fields, preparedBy);

  // ---- Autosave -------------------------------------------------------------------------------------------------
  const [baseline] = useState<MemoDraftValues>(() =>
    draftValuesOf(initial, directory ? initialTemplateFields(template, directory) : null),
  );
  const sync = useMemoDraftSync({
    account: draftAccount,
    memoId,
    baseline,
    values: draftValuesOf(values, directory ? fields : null),
    onRestore: useCallback(
      (draft: MemoDraftValues) => {
        const restored = restoreFromDraft(draft, directory, { values, fields });
        setValues(restored.values);
        setFields(restored.fields);
      },
      // The latest values are read when it runs: the restore replaces them anyway.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [directory],
    ),
  });
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  });

  // The page header's Submit would approve the saved memo, not this page. While a working copy might hold changes
  // that were not saved into the memo (still loading, differs from the saved text, or in conflict), tell it.
  const setReviewNeeded = useMemoReviewGate();
  const workingValues = draftValuesOf(values, directory ? fields : null);
  const reviewNeeded =
    Boolean(memoId && draftAccount) &&
    (sync.state.status === 'loading' ||
      sync.state.status === 'conflict' ||
      keyOf(workingValues) !== keyOf(baseline));
  useEffect(() => {
    setReviewNeeded?.(reviewNeeded);
    return () => setReviewNeeded?.(false);
  }, [reviewNeeded, setReviewNeeded]);

  // The submit settles pending text, freezes autosave (a late write must not bring the draft back after the server
  // deleted it) and resumes only if the server refused. On success the server action redirects.
  const inFlight = useRef(false);
  const [saved, setSaved] = useState(false);
  const [state, formAction, pending] = useActionState<MemoFormState, FormData>(
    async (prev, form) => {
      if (inFlight.current) return prev;
      inFlight.current = true;
      try {
        await syncRef.current.settle();
        syncRef.current.freeze();
        form.set('draftRevision', syncRef.current.revision() ?? '');
        const next = (await action(prev, form)) ?? prev;
        if (next.savedTo) {
          // Saved: autosave stays stopped (the server deleted the working copy) until the form is rebuilt.
          setSaved(true);
          onSaved(next.savedTo);
          return next;
        }
        syncRef.current.resume();
        return next;
      } finally {
        inFlight.current = false;
      }
    },
    initialState,
  );

  // A refusal is announced as a toast; field errors stay inline and take focus, so they remain reachable.
  const err = state.fieldErrors;
  const hasFieldErrors = Object.keys(err).length > 0;
  useEffect(() => {
    if (state === initialState) return;
    if (state.error || hasFieldErrors) {
      toast.error(state.error ?? 'Check the highlighted fields.', { id: 'memo-form-error' });
    }
    if (state.error && !hasFieldErrors) summaryRef.current?.focus();
    else if (err.template) departmentRef.current?.focus();
    else if (err.title) titleRef.current?.focus();
    else if (err.amount) amountRef.current?.focus();
  }, [state, initialState, hasFieldErrors, err.template, err.title, err.amount]);

  // ---- Footer actions --------------------------------------------------------------------------------------------
  const pdfSource: PdfSource = preview
    ? { kind: 'draft', input: memoPdfInputOf(preview, values.title, values.body) }
    : NO_SOURCE;
  const pdf = useMemoPdfActions(pdfSource, paperId);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteDraft = async (): Promise<boolean> => {
    setDeleteError(null);
    if (memoId && !draftAccount) {
      setDeleteError('Reload this page, then delete the draft.');
      return false;
    }
    if (memoId && draftAccount) {
      sync.freeze();
      const failure = await discardSavedMemo(memoId, draftAccount);
      if (failure) {
        sync.resume();
        setDeleteError(failure);
        return false;
      }
    } else if (!(await sync.discard())) {
      sync.resume();
      setDeleteError('The draft could not be deleted. Check your connection and try again.');
      return false;
    }
    toast.success('Draft deleted');
    router.push('/memos');
    return true;
  };

  const label = submitLabel ?? (memoId ? 'Done' : 'Next');

  return (
    <div className={directory ? templateStyles.layout : undefined}>
      <form action={formAction} noValidate className={styles.form} onBlur={() => sync.flush()}>
        {directory ? (
          <>
            <input type="hidden" name="template" value={JSON.stringify(templateInput)} />
            <Field label="Department" error={err.template}>
              {(control) => (
                <Select
                  {...control}
                  ref={departmentRef}
                  value={fields.departmentId}
                  onChange={(e) => setField('departmentId')(e.target.value)}
                  required
                >
                  <option value="">Choose department</option>
                  {directory.departments.map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {directory.departments.length === 0 ? (
              <Alert tone="warning">
                Add a department to the company directory before creating a memo.
              </Alert>
            ) : null}
            <Field label="Date">
              {(control) => (
                <DatePicker {...control} value={fields.date} onChange={setField('date')} required />
              )}
            </Field>
          </>
        ) : null}
        {memoId ? <input type="hidden" name="memoId" value={memoId} /> : null}
        {memoVersion !== undefined ? (
          <input type="hidden" name="expectedVersion" value={memoVersion} />
        ) : null}
        {draftAccount ? <input type="hidden" name="draftAccount" value={draftAccount} /> : null}

        {state.error && !hasFieldErrors ? (
          <Alert ref={summaryRef} tabIndex={-1} tone="error" role="alert">
            {state.error}
          </Alert>
        ) : null}

        <Field label={directory ? 'Subject' : 'Title'} error={err.title}>
          {(control) => (
            <Input
              ref={titleRef}
              name="title"
              value={values.title}
              onChange={set('title')}
              maxLength={200}
              required
              {...control}
            />
          )}
        </Field>

        <Field label={directory ? 'Body' : 'Details'} error={err.body}>
          {(control) => (
            <Textarea
              name="body"
              rows={6}
              value={values.body}
              onChange={set('body')}
              maxLength={10000}
              {...control}
            />
          )}
        </Field>

        {directory ? (
          <>
            <Field label="Closing">
              {(control) => (
                <Textarea
                  {...control}
                  value={fields.closing}
                  onChange={(e) => setField('closing')(e.target.value)}
                  maxLength={1000}
                />
              )}
            </Field>
            <SignerSection
              people={directory.people}
              currentUserId={preparedBy}
              recommenders={fields.recommenders}
              onRecommenders={setField('recommenders')}
              approvedBy={fields.approvedBy}
              onApprovedBy={setField('approvedBy')}
            />
          </>
        ) : null}
        <div className={styles.amountRow}>
          <Field
            label="Amount"
            hint="For example 1250.50. The NPR value is frozen when you save, using that day's rate."
            error={err.amount}
          >
            {(control) => (
              <Input
                ref={amountRef}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                value={values.amount}
                onChange={set('amount')}
                required
                className={styles.numeric}
                {...control}
              />
            )}
          </Field>

          <Field label="Currency" error={err.currency}>
            {(control) => (
              <Select
                name="currency"
                value={values.currency}
                onChange={set('currency')}
                {...control}
              >
                {CURRENCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className={templateStyles.footer}>
          <div className={templateStyles.footerIcons} role="group" aria-label="Draft actions">
            {canDiscard ? (
              <ConfirmDialog
                trigger={
                  <button
                    type="button"
                    className={`${templateStyles.iconAction} ${templateStyles.iconDanger}`}
                    aria-label="Delete draft"
                    title="Delete draft"
                  >
                    <TrashIcon size={18} />
                  </button>
                }
                title="Delete this draft?"
                description={
                  memoId
                    ? 'The draft and its attachments are removed. This cannot be undone.'
                    : 'What you typed here is removed. This cannot be undone.'
                }
                confirmLabel="Delete draft"
                destructive
                onConfirm={deleteDraft}
                onOpenChange={(open) => {
                  if (open) setDeleteError(null);
                }}
              >
                {deleteError ? (
                  <Alert tone="error" role="alert">
                    {deleteError}
                  </Alert>
                ) : null}
              </ConfirmDialog>
            ) : null}
            {directory ? (
              <>
                <button
                  type="button"
                  className={templateStyles.iconAction}
                  aria-label="Download preview as PDF"
                  title="Download preview as PDF"
                  disabled={pdf.busy}
                  onClick={() => void pdf.download()}
                >
                  <DownloadIcon size={18} />
                </button>
                <button
                  type="button"
                  className={templateStyles.iconAction}
                  aria-label="Print preview"
                  title="Print preview"
                  onClick={() => void pdf.print()}
                >
                  <PrintIcon size={18} />
                </button>
              </>
            ) : null}
          </div>
          <div className={templateStyles.footerEnd}>
            <SaveState status={sync.state.status} />
            <Button
              type="submit"
              name="intent"
              value={memoId ? 'save' : 'attach'}
              disabled={pending || saved}
              aria-busy={pending || undefined}
            >
              {pending ? 'Saving' : label}
            </Button>
          </div>
        </div>
      </form>
      <ConflictDialog conflict={sync.state.conflict} onChoose={sync.resolveConflict} />
      {preview ? (
        <MemoPreview
          template={preview}
          title={values.title}
          body={values.body}
          source="current"
          sticky
          noun="preview"
          showActions={false}
          paperId={paperId}
        />
      ) : null}
    </div>
  );
}

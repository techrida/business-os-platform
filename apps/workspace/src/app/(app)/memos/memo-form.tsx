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
import type { SelectHandle } from '@/components/ui/select';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';
import { memoPdfInputOf } from '@/lib/memo-pdf-input';
import type { MemoDraftValues } from '@/lib/memo-working-draft-types';

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
import { useMemoReviewGate, useMemoSaveReporter } from './memo-review-gate';
import templateStyles from './memo-template.module.css';
import { SignerSection } from './signer-section';
import { useMemoDraftSync } from './use-memo-draft-sync';
import { useMemoPdfActions } from './use-memo-pdf-actions';
import { Tooltip } from '@/components/ui/tooltip';

const NO_SOURCE: PdfSource = { kind: 'saved', memoId: '' };

/** Card heading with its Figma eyebrow ("01 · The basics"). The eyebrow is decoration. */
function SectionTitle({ eyebrow, children }: { eyebrow: string; children: string }) {
  return (
    <>
      <span aria-hidden="true" className={templateStyles.eyebrow}>
        {eyebrow}
      </span>
      {children}
    </>
  );
}

/**
 * The memo create and edit form. One component for both, because they share fields and rules; the
 * server action passed in decides what happens on submit. Inputs are controlled so a refusal does
 * not wipe what was typed (React 19 resets uncontrolled fields after every action), and so the paper
 * beside the form is a pure function of the same values: every keystroke reaches it.
 *
 * Autosave: while the person types, a working copy is kept on the server for their account (see
 * use-memo-draft-sync.ts), so a refresh or a later sign-in finds it again. The footer's primary button is
 * the next real step ("Next" creates the memo and opens its approval preview; "Done" saves an edit); there is no
 * separate "Save draft".
 */
export function MemoForm(props: MemoFormProps) {
  const router = useRouter();
  const [epoch, setEpoch] = useState(0);
  const [navigating, startNavigation] = useTransition();
  const wasNavigating = useRef(false);
  const reportSave = useMemoSaveReporter();
  // After Done the page shows the saved memo in the same route. The form is rebuilt once that page has arrived (new
  // baseline, autosave running again, header Submit released), whatever the saved text turned out to be. Only then
  // is the save reported as done: a Submit pressed meanwhile must send the saved memo's new version (R2-019).
  useEffect(() => {
    if (wasNavigating.current && !navigating) {
      setEpoch((n) => n + 1);
      reportSave?.('saved');
    }
    wasNavigating.current = navigating;
  }, [navigating, reportSave]);
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
  const departmentRef = useRef<SelectHandle>(null);
  const paperId = useId();

  const set = (key: 'title' | 'body') => (e: { target: { value: string } }) =>
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
  const reportSave = useMemoSaveReporter();
  const [state, formAction, pending] = useActionState<MemoFormState, FormData>(
    async (prev, form) => {
      if (inFlight.current) return prev;
      inFlight.current = true;
      // 'saving' was reported by onSubmit (an update made inside this action would only show once it ends). A save
      // stays 'saving' until the outer form has the saved page; any other ending is a failed save.
      let outcome: 'saving' | 'failed' = 'failed';
      try {
        await syncRef.current.settle();
        syncRef.current.freeze();
        form.set('draftRevision', syncRef.current.revision() ?? '');
        const next = (await action(prev, form)) ?? prev;
        if (next.savedTo) {
          // Saved: autosave stays stopped (the server deleted the working copy) until the form is rebuilt.
          outcome = 'saving';
          setSaved(true);
          onSaved(next.savedTo);
          return next;
        }
        syncRef.current.resume();
        return next;
      } finally {
        inFlight.current = false;
        if (outcome === 'failed') reportSave?.('failed');
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
  }, [state, initialState, hasFieldErrors, err.template, err.title]);

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
      <form
        action={formAction}
        noValidate
        className={templateStyles.controls}
        onBlur={() => sync.flush()}
        onSubmit={() => reportSave?.('saving')}
      >
        {directory ? (
          <input type="hidden" name="template" value={JSON.stringify(templateInput)} />
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

        <Panel
          title={
            <SectionTitle eyebrow="01 · The basics">
              {memoId ? 'Edit memo' : 'Memo details'}
            </SectionTitle>
          }
        >
          {directory ? (
            <div className={templateStyles.metadataRow}>
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
              <Field label="Date">
                {(control) => (
                  <DatePicker
                    {...control}
                    value={fields.date}
                    onChange={setField('date')}
                    required
                  />
                )}
              </Field>
            </div>
          ) : null}
          {directory && directory.departments.length === 0 ? (
            <Alert tone="warning">
              Add a department to the company directory before creating a memo.
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
          ) : null}
        </Panel>

        {directory ? (
          <Panel title={<SectionTitle eyebrow="02 · Sign-off">Sign-off</SectionTitle>}>
            <SignerSection
              people={directory.people}
              currentUserId={preparedBy}
              recommenders={fields.recommenders}
              onRecommenders={setField('recommenders')}
              approvedBy={fields.approvedBy}
              onApprovedBy={setField('approvedBy')}
              approverRule={directory.approverRule}
            />
          </Panel>
        ) : null}
        <div className={templateStyles.footer}>
          <div className={templateStyles.footerIcons} role="group" aria-label="Draft actions">
            {canDiscard ? (
              <ConfirmDialog
                trigger={
                  <Tooltip content="Delete draft">
                    <button
                      type="button"
                      className={`${templateStyles.iconAction} ${templateStyles.iconDanger}`}
                      aria-label="Delete draft"
                    >
                      <TrashIcon size={18} />
                    </button>
                  </Tooltip>
                }
                title="Delete this draft?"
                description={
                  memoId
                    ? 'The draft is removed. This cannot be undone.'
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
                <Tooltip content="Download preview as PDF">
                  <button
                    type="button"
                    className={templateStyles.iconAction}
                    aria-label="Download preview as PDF"
                    disabled={pdf.busy}
                    onClick={() => void pdf.download()}
                  >
                    <DownloadIcon size={18} />
                  </button>
                </Tooltip>
                <Tooltip content="Print preview">
                  <button
                    type="button"
                    className={templateStyles.iconAction}
                    aria-label="Print preview"
                    onClick={() => void pdf.print()}
                  >
                    <PrintIcon size={18} />
                  </button>
                </Tooltip>
              </>
            ) : null}
          </div>
          <div className={templateStyles.footerEnd}>
            <SaveState status={sync.state.status} />
            <Button type="submit" disabled={pending || saved} aria-busy={pending || undefined}>
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

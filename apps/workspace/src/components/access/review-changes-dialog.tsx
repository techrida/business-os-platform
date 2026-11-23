'use client';

import type {
  AccessChange,
  AccessImpactBucket,
  AccessPreviewResponse,
  AccessWarning,
  AccessWarningCode,
  CheckPersonReport,
} from '@bos/contracts';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';

import {
  ACCESS_SAVED_MESSAGE,
  NOTE_LIMIT,
  acknowledgedCodes,
  canSave,
  carryTicks,
  hasBlockedWarning,
  impactSentence,
  warningKey,
} from './review-model';
import styles from './review-changes-dialog.module.css';
import { Checkbox } from '@/components/ui/checkbox';

export type ReviewPreviewResult =
  | { ok: true; preview: AccessPreviewResponse }
  | {
      ok: false;
      message: string;
      /**
       * `refused`: the server refused these changes (a 422 with the save's own field errors or
       * blocked warnings). The same changes are refused again, so no Try again is offered.
       */
      kind?: 'refused' | 'error' | undefined;
      warnings?: AccessWarning[] | undefined;
      fieldErrors?: Record<string, string> | undefined;
    };

export type ReviewSaveResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'stale' | 'confirmation' | 'invalid' | 'error';
      message: string;
      warnings?: AccessWarning[] | undefined;
      fieldErrors?: Record<string, string> | undefined;
    };

export type ReviewCheckResult =
  { ok: true; report: CheckPersonReport } | { ok: false; message: string };

/** Dry run of the staged changes (`POST /v1/admin/access/preview`). Never writes. */
export type ReviewRunPreview = (changes: AccessChange[]) => Promise<ReviewPreviewResult>;
/** The save itself, against the revision the screen loaded. */
export type ReviewRunSave = (input: {
  acknowledged: AccessWarningCode[];
  note: string;
}) => Promise<ReviewSaveResult>;
/** Optional: the Check a person report with the staged changes applied (a preview with `person`). */
export type ReviewRunCheck = (input: {
  changes: AccessChange[];
  person: string;
}) => Promise<ReviewCheckResult>;

export interface ReviewPerson {
  id: string;
  name: string;
  /** Shown after the name in the picker: a department or an email. */
  description?: string | undefined;
}

export interface ReviewChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Review changes to Leads", "Review changes to the Sales role". */
  title: string;
  changes: AccessChange[];
  /** The access revision the screen loaded; a new one re-runs the preview. */
  expectedRevision: string;
  runPreview: ReviewRunPreview;
  runSave: ReviewRunSave;
  onSaved: () => void;
  onStale: () => void;
  /** With `runCheck`, offers "Check a person with these changes" inside the dialog. */
  people?: readonly ReviewPerson[] | undefined;
  runCheck?: ReviewRunCheck | undefined;
}

/**
 * The one review step before any access save (spec 7.3): what changes, who is affected and the
 * warnings, all from the server's dry run; an optional note; Back and Save changes in the fixed
 * footer. Save stays disabled until the dry run succeeded, no warning blocks it and every
 * confirm warning is ticked. A full-screen sheet on a phone. Radix traps focus and closes on
 * Escape without saving. The dialog has no trigger element (callers open it through `open`), so
 * this component returns focus itself to whatever had it when the dialog opened.
 */
export function ReviewChangesDialog(props: ReviewChangesDialogProps) {
  const { open } = props;
  const opener = useRef<HTMLElement | null>(null);
  // A layout effect runs before the dialog's own focus move (a passive effect), so the element
  // read here is still the one that opened it.
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
  useEffect(() => {
    if (open) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  }, [open]);

  if (!open) return null;
  // A new set of changes or a new revision starts a fresh review (and a fresh dry run).
  const key = `${props.expectedRevision}:${JSON.stringify(props.changes)}`;
  return <OpenReview key={key} {...props} />;
}

const PREVIEW_FAILED = 'Could not preview these changes. Try again in a moment.';

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string; refused: boolean }
  | { status: 'ready'; preview: AccessPreviewResponse };

interface SaveProblem {
  message: string;
  fieldErrors?: Record<string, string> | undefined;
}

function OpenReview({
  onOpenChange,
  title,
  changes,
  runPreview,
  runSave,
  onSaved,
  onStale,
  people,
  runCheck,
}: ReviewChangesDialogProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [warnings, setWarnings] = useState<AccessWarning[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [view, setView] = useState<'review' | 'check'>('review');
  const noteId = useId();

  // The latest callbacks without re-running the dry run each time the parent renders.
  const latest = useRef({ runPreview, changes });
  useEffect(() => {
    latest.current = { runPreview, changes };
  });

  useEffect(() => {
    let live = true;
    latest.current
      .runPreview(latest.current.changes)
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setWarnings(result.preview.warnings);
          setTicked(new Set());
          setState({ status: 'ready', preview: result.preview });
        } else {
          setState({
            status: 'error',
            message: result.message,
            refused: result.kind === 'refused',
          });
        }
      })
      .catch(() => {
        if (live) setState({ status: 'error', message: PREVIEW_FAILED, refused: false });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const previewed = state.status === 'ready';
  const announcement =
    state.status === 'loading' ? 'Working out what would change…' : saving ? 'Saving…' : '';
  const saveEnabled = canSave({ previewed, saving, warnings, ticked });
  const blocked = hasBlockedWarning(warnings);

  function retry() {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }

  function toggle(key: string, on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function save() {
    if (!saveEnabled) return;
    const acknowledged = acknowledgedCodes(warnings, ticked);
    setSaving(true);
    setProblem(null);
    let result: ReviewSaveResult;
    try {
      result = await runSave({ acknowledged, note: note.trim() });
    } catch {
      result = {
        ok: false,
        kind: 'error',
        message: 'Access changes could not be saved. Try again in a moment.',
      };
    }
    setSaving(false);
    if (result.ok) {
      toast.success(ACCESS_SAVED_MESSAGE);
      onOpenChange(false);
      onSaved();
      return;
    }
    toast.error(result.message.split('\n')[0] ?? result.message);
    if (result.kind === 'stale') {
      onOpenChange(false);
      onStale();
      return;
    }
    if (result.warnings && result.warnings.length > 0) {
      // The server lists only the warnings not yet acknowledged: keep the ones already shown (and
      // ticked) so the two sets cannot alternate forever.
      const fresh = result.warnings;
      const merged =
        result.kind === 'confirmation'
          ? [...fresh, ...warnings.filter((w) => !fresh.some((n) => n.code === w.code))]
          : fresh;
      setWarnings(merged);
      setTicked(carryTicks(merged, acknowledged));
    }
    setProblem({ message: result.message, fieldErrors: result.fieldErrors });
  }

  const footer = (
    <>
      <Button variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>
        Back
      </Button>
      <Button disabled={!saveEnabled} aria-busy={saving || undefined} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={title}
      size="large"
      locked={saving}
      closeOnOutsideClick={false}
      className={styles.sheet}
      footer={footer}
    >
      {view === 'check' && runCheck ? (
        <CheckWithChanges
          changes={changes}
          people={people ?? []}
          runCheck={runCheck}
          onBack={() => setView('review')}
        />
      ) : (
        <div className={styles.stack}>
          {state.status === 'loading' ? <PreviewSkeleton /> : null}
          {state.status === 'error' && state.refused ? (
            // Refused changes are refused again on retry: the reason and Back, which returns to
            // the card where the refused values are marked.
            <Alert tone="error" role="alert">
              <span className={styles.preLine}>{state.message}</span>
            </Alert>
          ) : null}
          {state.status === 'error' && !state.refused ? (
            <Alert
              tone="error"
              role="alert"
              actions={
                <Button variant="secondary" size="small" onClick={retry}>
                  Try again
                </Button>
              }
            >
              {state.message}
            </Alert>
          ) : null}
          {state.status === 'ready' ? (
            <>
              <section aria-labelledby={`${noteId}-what`} className={styles.block}>
                <h3 id={`${noteId}-what`} className={styles.heading}>
                  What changes
                </h3>
                {state.preview.applied.length === 0 ? (
                  <p className={styles.muted}>Nothing would change.</p>
                ) : (
                  <ul className={styles.list}>
                    {state.preview.applied.map((line, index) => (
                      <li key={`${line.label}:${index}`} className={styles.change}>
                        <span>
                          {line.label}: {line.from} <span aria-hidden="true">→</span>
                          <span className="sr-only"> to </span> {line.to}
                        </span>
                        {line.serverAdded ? (
                          <span className={styles.also}>also changes</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby={`${noteId}-who`} className={styles.block}>
                <h3 id={`${noteId}-who`} className={styles.heading}>
                  Who is affected
                </h3>
                <ImpactLine bucket={state.preview.impact.widened} direction="more" />
                <ImpactLine bucket={state.preview.impact.narrowed} direction="less" />
                {runCheck ? (
                  <Button
                    variant="tertiary"
                    size="small"
                    className={styles.inlineAction}
                    onClick={() => setView('check')}
                  >
                    Check a person with these changes
                  </Button>
                ) : null}
              </section>

              {warnings.length > 0 ? (
                <section aria-labelledby={`${noteId}-warn`} className={styles.block}>
                  <h3 id={`${noteId}-warn`} className={styles.heading}>
                    Warnings
                  </h3>
                  <ul className={styles.list}>
                    {warnings.map((warning, index) => {
                      const key = warningKey(warning, index);
                      if (warning.severity === 'confirm') {
                        return (
                          <li key={key} className={styles.warning}>
                            <label className={styles.confirm}>
                              <Checkbox
                                checked={ticked.has(key)}
                                disabled={saving}
                                onCheckedChange={(nextChecked) => toggle(key, nextChecked)}
                              />
                              <span>I understand: {warning.message}</span>
                            </label>
                          </li>
                        );
                      }
                      return (
                        <li key={key}>
                          <Alert tone={warning.severity === 'blocked' ? 'error' : 'info'}>
                            {warning.message}
                          </Alert>
                        </li>
                      );
                    })}
                  </ul>
                  {blocked ? (
                    <p className={styles.muted}>These changes cannot be saved as they are.</p>
                  ) : null}
                </section>
              ) : null}

              <div className={styles.block}>
                <label htmlFor={noteId} className={styles.noteLabel}>
                  Why are you changing this? (optional)
                </label>
                <Textarea
                  id={noteId}
                  value={note}
                  maxLength={NOTE_LIMIT}
                  rows={2}
                  disabled={saving}
                  aria-describedby={`${noteId}-count`}
                  onChange={(event) => setNote(event.currentTarget.value)}
                />
                <span id={`${noteId}-count`} className={styles.count}>
                  {note.length} of {NOTE_LIMIT} characters
                </span>
              </div>

              {problem ? (
                <Alert tone="error" role="alert">
                  <span className={styles.preLine}>{problem.message}</span>
                  {problem.fieldErrors ? (
                    <ul className={styles.list}>
                      {Object.entries(problem.fieldErrors).map(([field, message]) => (
                        <li key={field}>{message}</li>
                      ))}
                    </ul>
                  ) : null}
                </Alert>
              ) : null}
            </>
          ) : null}
          <span className="sr-only" role="status">
            {announcement}
          </span>
        </div>
      )}
    </Dialog>
  );
}

function PreviewSkeleton() {
  return (
    <div className={styles.stack} aria-hidden="true">
      <Skeleton height={18} width="40%" />
      <Skeleton height={14} />
      <Skeleton height={14} width="80%" />
      <Skeleton height={18} width="40%" />
      <Skeleton height={14} width="70%" />
    </div>
  );
}

function ImpactLine({
  bucket,
  direction,
}: {
  bucket: AccessImpactBucket;
  direction: 'more' | 'less';
}) {
  const [showAll, setShowAll] = useState(false);
  const names = bucket.names ?? [];
  const canExpand = names.length > bucket.sample.length;
  return (
    <div className={styles.impact}>
      <p className={styles.line}>{impactSentence(bucket, direction)}</p>
      {canExpand ? (
        <Button
          variant="tertiary"
          size="small"
          className={styles.inlineAction}
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Hide names' : `Show all ${bucket.people}`}
        </Button>
      ) : null}
      {showAll ? (
        <ul className={styles.names}>
          {names.map((name, index) => (
            <li key={`${name}:${index}`}>{name}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CheckWithChanges({
  changes,
  people,
  runCheck,
  onBack,
}: {
  changes: AccessChange[];
  people: readonly ReviewPerson[];
  runCheck: ReviewRunCheck;
  onBack: () => void;
}) {
  const [person, setPerson] = useState('');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'done'; result: ReviewCheckResult }
  >({ status: 'idle' });
  const labelId = useId();
  const request = useRef(0);

  async function pick(id: string) {
    setPerson(id);
    if (!id) {
      setResult({ status: 'idle' });
      return;
    }
    const mine = ++request.current;
    setResult({ status: 'loading' });
    let answer: ReviewCheckResult;
    try {
      answer = await runCheck({ changes, person: id });
    } catch {
      answer = { ok: false, message: 'Could not check this person. Try again in a moment.' };
    }
    if (request.current === mine) setResult({ status: 'done', result: answer });
  }

  return (
    <div className={styles.stack}>
      <Button variant="tertiary" size="small" className={styles.inlineAction} onClick={onBack}>
        <span aria-hidden="true">←</span> Back to the changes
      </Button>
      <div className={styles.block}>
        <span id={labelId} className={styles.noteLabel}>
          Person
        </span>
        <Combobox
          labelledBy={labelId}
          options={people.map((p) => ({ id: p.id, label: p.name, description: p.description }))}
          value={person}
          onChange={(id) => void pick(id)}
          open={open}
          onOpenChange={setOpen}
          placeholder="Search by name or email"
          emptyText="No people to choose from."
        />
      </div>
      {result.status === 'idle' ? (
        <p className={styles.muted}>
          Pick a person to see what this person could open after these changes.
        </p>
      ) : null}
      {result.status === 'loading' ? <PreviewSkeleton /> : null}
      {result.status === 'done' && !result.result.ok ? (
        <Alert tone="error" role="alert">
          {result.result.message}
        </Alert>
      ) : null}
      {result.status === 'done' && result.result.ok ? (
        <CheckRows report={result.result.report} />
      ) : null}
    </div>
  );
}

function CheckRows({ report }: { report: CheckPersonReport }) {
  return (
    <ul className={styles.list}>
      {report.areas.map((row) => {
        const changed =
          row.previousScopeLabel !== undefined && row.previousScopeLabel !== row.scopeLabel;
        return (
          <li key={row.area} className={styles.checkRow}>
            <p className={styles.checkArea}>{row.label}</p>
            <p className={styles.line}>
              Can see: {row.scopeLabel}
              {row.totalCount > 0 ? ` (${row.visibleCount} of ${row.totalCount})` : ''}
              {changed ? <span className={styles.was}> was {row.previousScopeLabel}</span> : null}
            </p>
            {row.actions.length > 0 ? (
              <p className={styles.muted}>
                Can also: {row.actions.map((action) => action.label).join(', ')}
              </p>
            ) : null}
            {row.assignableCount !== null ? (
              <p className={styles.muted}>
                Can assign to {row.assignableCount}{' '}
                {row.assignableCount === 1 ? 'person' : 'people'}
              </p>
            ) : null}
            {row.why.length > 0 ? <p className={styles.muted}>Why: {row.why.join(' ')}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

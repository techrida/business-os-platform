'use client';

import type { ActivityDto, LeadOwnerOption, SchedulableActivityKind } from '@bos/contracts';
import { useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';

import {
  rescheduleFollowUpAction,
  scheduleFollowUpAction,
  type FollowUpState,
} from '@/app/(app)/leads/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { MemberPicker } from '@/components/ui/member-picker';
import { toast } from '@/components/ui/toast';

import { ActivityTypeButtons } from './activity-type-buttons';
import { ownerOptionName } from './owner-field';
import { subjectOf, type FollowUpSubjectKind } from './follow-up-subject';
import { SCHEDULE_ACTIVITY_KINDS, type FieldErrors } from './forms';
import styles from './follow-ups-card.module.css';

/** An ISO time as the Kathmandu wall time a `datetime-local` input shows, or '' when unreadable. */
export function toKathmanduLocal(iso: string | null | undefined): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return '';
  return new Date(at + 345 * 60_000).toISOString().slice(0, 16);
}

interface Outcome {
  ok?: boolean | undefined;
  error?: string | undefined;
  fieldErrors?: FieldErrors | undefined;
}

/**
 * Dialog submit plumbing shared by Schedule and Reschedule: the action runs in a transition, a
 * success closes the dialog and toasts, a refusal stays open with field errors and an alert (the
 * toast alone is not enough for a blocking error, UIP-FEED-001). Opening again starts clean.
 */
function useDialogSubmit(run: (data: FormData) => Promise<Outcome>, success: string) {
  const [open, setOpenState] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({});
  const [pending, startTransition] = useTransition();
  // Bumped on every open, so the form remounts with its defaults instead of the last attempt.
  const [round, setRound] = useState(0);

  function setOpen(next: boolean) {
    if (next) {
      setOutcome({});
      setRound((r) => r + 1);
    }
    setOpenState(next);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter in a field still submits while the button is disabled; one request at a time.
    if (pending) return;
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await run(data);
      setOutcome(result);
      if (result.ok) {
        setOpenState(false);
        toast.success(success);
      }
    });
  }

  return { open, setOpen, outcome, pending, round, onSubmit };
}

function Footer({ formId, pending, label }: { formId: string; pending: boolean; label: string }) {
  return (
    <>
      <DialogClose asChild>
        <Button variant="secondary" disabled={pending}>
          Cancel
        </Button>
      </DialogClose>
      <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
        {pending ? 'Saving' : label}
      </Button>
    </>
  );
}

function FormAlert({ error }: { error: string | undefined }) {
  return error ? (
    <Alert tone="error" role="alert">
      {error}
    </Alert>
  ) : null;
}

/** The people a follow-up can go to, as the one member picker takes them. */
const assigneePeople = (owners: readonly LeadOwnerOption[]) =>
  owners.map((o) => ({ id: o.userId, name: ownerOptionName(o), role: o.role ?? null }));

const has = (owners: readonly LeadOwnerOption[], id: string | null | undefined) =>
  id !== null && id !== undefined && owners.some((o) => o.userId === id);

/** A person the dialog names without them being in the assignable list: the signed-in user, or a record's owner. */
export interface NamedPerson {
  userId: string;
  name: string;
}

/**
 * What the "Assigned to" box shows (UIP-FORM-006: a real person, never a placeholder phrase). The form posts nothing
 * when the box stands for a default, and the API then gives the follow-up to that same person.
 * - the record's owner is assignable: the box starts on them;
 * - the owner is not assignable (outside the caller's list): the box still names them, from the record, with a hint;
 * - the record has no owner: the box names the signed-in user, who gets it;
 * - only when neither is known is the box empty, with a prompt.
 */
export function assigneeFace(args: {
  owners: readonly LeadOwnerOption[];
  ownerUserId: string | null | undefined;
  ownerName?: string | null | undefined;
  me?: NamedPerson | null | undefined;
  recordNoun: string;
}): {
  defaultValue: string;
  standsFor: string | undefined;
  current: { id: string; name: string; role?: string | null } | undefined;
  hint: string | undefined;
  placeholder: string;
} {
  const { owners, ownerUserId, ownerName, me, recordNoun } = args;
  const roleOf = (id: string) => owners.find((o) => o.userId === id)?.role ?? null;
  if (ownerUserId !== null && ownerUserId !== undefined) {
    if (has(owners, ownerUserId)) {
      return {
        defaultValue: ownerUserId,
        standsFor: undefined,
        current: undefined,
        hint: undefined,
        placeholder: 'Search by name',
      };
    }
    const name = ownerName?.trim() || 'Unnamed user';
    return {
      defaultValue: '',
      standsFor: ownerUserId,
      current: { id: ownerUserId, name },
      hint: `${name} owns this ${recordNoun} but is not someone you can assign to, so it goes to them unless you choose another person.`,
      placeholder: 'Search by name',
    };
  }
  if (me) {
    return {
      defaultValue: '',
      standsFor: me.userId,
      current: has(owners, me.userId)
        ? undefined
        : { id: me.userId, name: me.name, role: roleOf(me.userId) },
      hint: `This ${recordNoun} has no owner, so the follow-up is yours unless you choose another person.`,
      placeholder: 'Search by name',
    };
  }
  return {
    defaultValue: '',
    standsFor: undefined,
    current: undefined,
    hint: `This ${recordNoun} has no owner. Choose who the follow-up goes to.`,
    placeholder: 'Choose a person',
  };
}

export interface ScheduleFollowUpDialogProps {
  /** The record the follow-up is planned on. Default kind: a lead. */
  subjectKind?: Extract<FollowUpSubjectKind, 'leadId' | 'opportunityId'> | undefined;
  subjectId: string;
  /** The record's owner, the default assignee. */
  ownerUserId: string | null;
  /** The owner's name from the record, shown when they are not in `owners`. */
  ownerName?: string | null | undefined;
  /** The signed-in user, named in the box when the record has no owner (the API gives it to them). */
  me?: NamedPerson | null | undefined;
  /** People the caller may assign to (`GET /v1/leads/owners`, or `/v1/opportunities/follow-up-assignees`). */
  owners: readonly LeadOwnerOption[];
  /** The opening control. Default: a secondary "Schedule follow-up" button. */
  trigger?: ReactNode;
}

/**
 * Schedule follow-up (D39, D40): type buttons (call, meeting, email), an optional subject that
 * defaults to the type's label, the due time in Kathmandu time, the assignee (the record's owner by
 * default) and a note. Saving plans an activity on the lead or deal; it shows with its planned ones.
 */
export function ScheduleFollowUpDialog({
  subjectKind = 'leadId',
  subjectId,
  ownerUserId,
  ownerName,
  me,
  owners,
  trigger,
}: ScheduleFollowUpDialogProps) {
  const formId = useId();
  const [kind, setKind] = useState<SchedulableActivityKind>('call');
  // The key the next submit sends: the same one after an unknown outcome, so a retry cannot plan
  // the follow-up twice; the action hands back a fresh one after a save or a refusal.
  const key = useRef<string | null>(null);

  const dialog = useDialogSubmit(async (data) => {
    data.set('idempotencyKey', (key.current ??= crypto.randomUUID()));
    const result = await scheduleFollowUpAction({ values: {}, fieldErrors: {} }, data);
    if (result.key) key.current = result.key;
    return result;
  }, 'Follow-up scheduled.');

  const face = assigneeFace({
    owners,
    ownerUserId,
    ownerName,
    me,
    recordNoun: subjectKind === 'leadId' ? 'lead' : 'opportunity',
  });
  const shown = dialog.outcome.fieldErrors ?? {};

  return (
    <Dialog
      trigger={
        trigger ?? (
          <Button variant="secondary" className={styles.trigger}>
            Schedule follow-up
          </Button>
        )
      }
      open={dialog.open}
      onOpenChange={(next) => {
        if (next) setKind('call');
        dialog.setOpen(next);
      }}
      title="Schedule follow-up"
      locked={dialog.pending}
      closeOnOutsideClick={false}
      footer={<Footer formId={formId} pending={dialog.pending} label="Schedule" />}
    >
      <form
        key={dialog.round}
        id={formId}
        noValidate
        onSubmit={dialog.onSubmit}
        className={styles.dialogForm}
      >
        <input type="hidden" name="subjectKind" value={subjectKind} />
        <input type="hidden" name="subjectId" value={subjectId} />
        <FormAlert error={dialog.outcome.error} />
        <ActivityTypeButtons
          kinds={SCHEDULE_ACTIVITY_KINDS}
          value={kind}
          onChange={setKind}
          name="kind"
          label="Type"
          {...(shown['kind'] ? { error: shown['kind'] } : {})}
        />
        <Field
          label="Subject"
          hint="Optional. Leave it empty to use the type."
          error={shown['subject']}
        >
          {(c) => <Input name="subject" maxLength={200} {...c} />}
        </Field>
        <Field label="Due" hint="Kathmandu time." error={shown['dueAt']}>
          {(c) => <DateTimePicker name="dueAt" required {...c} />}
        </Field>
        <Field label="Assigned to" hint={face.hint} error={shown['assigneeUserId']}>
          {(c) => (
            <MemberPicker
              labelledBy={c['aria-labelledby']}
              describedBy={c['aria-describedby']}
              invalid={c['aria-invalid'] === true}
              name="assigneeUserId"
              people={assigneePeople(owners)}
              defaultValue={face.defaultValue}
              emptyStandsFor={face.standsFor}
              current={face.current}
              placeholder={face.placeholder}
            />
          )}
        </Field>
        <Field label="Note" hint="Optional." error={shown['body']}>
          {(c) => <Textarea name="body" rows={3} maxLength={10000} {...c} />}
        </Field>
      </form>
    </Dialog>
  );
}

export interface RescheduleFollowUpDialogProps {
  /** Only for an item that does not carry its own subject ids: treat it as this lead's. */
  leadId?: string | undefined;
  item: Pick<
    ActivityDto,
    'id' | 'subject' | 'dueAt' | 'assigneeUserId' | 'assigneeName' | 'version'
  > &
    Partial<Pick<ActivityDto, FollowUpSubjectKind>>;
  owners: readonly LeadOwnerOption[];
  trigger: ReactNode;
}

/**
 * Move a planned follow-up to a new time, optionally to someone else. When the current assignee
 * is not in the caller's list, the default is "Keep current assignee" (nothing sent), so opening
 * and saving never reassigns it silently.
 */
export function RescheduleFollowUpDialog({
  leadId,
  item,
  owners,
  trigger,
}: RescheduleFollowUpDialogProps) {
  const formId = useId();
  const dialog = useDialogSubmit(
    (data): Promise<FollowUpState> => rescheduleFollowUpAction({}, data),
    'Follow-up rescheduled.',
  );
  const listed = has(owners, item.assigneeUserId);
  const current =
    !listed && item.assigneeUserId
      ? { id: item.assigneeUserId, name: item.assigneeName?.trim() || 'Unnamed user' }
      : undefined;
  const err = dialog.outcome.fieldErrors ?? {};
  // The server refreshes this record's page; it builds the path from the kind and id itself.
  const subject = subjectOf(item) ?? (leadId ? { kind: 'leadId' as const, id: leadId } : null);

  return (
    <Dialog
      trigger={trigger}
      open={dialog.open}
      onOpenChange={dialog.setOpen}
      title="Reschedule follow-up"
      description={item.subject}
      locked={dialog.pending}
      closeOnOutsideClick={false}
      footer={<Footer formId={formId} pending={dialog.pending} label="Reschedule" />}
    >
      <form
        key={dialog.round}
        id={formId}
        noValidate
        onSubmit={dialog.onSubmit}
        className={styles.dialogForm}
      >
        {subject ? (
          <>
            <input type="hidden" name="subjectKind" value={subject.kind} />
            <input type="hidden" name="subjectId" value={subject.id} />
          </>
        ) : null}
        <input type="hidden" name="activityId" value={item.id} />
        <input type="hidden" name="expectedVersion" value={item.version} />
        <FormAlert error={dialog.outcome.error} />
        <Field label="New due time" hint="Kathmandu time." error={err['dueAt']}>
          {(c) => (
            <DateTimePicker
              name="dueAt"
              defaultValue={toKathmanduLocal(item.dueAt)}
              required
              {...c}
            />
          )}
        </Field>
        <Field
          label="Assigned to"
          hint={
            current
              ? `${current.name} cannot be assigned by you; leave it to keep them, or choose another person.`
              : undefined
          }
          error={err['assigneeUserId']}
        >
          {(c) => (
            <MemberPicker
              labelledBy={c['aria-labelledby']}
              describedBy={c['aria-describedby']}
              invalid={c['aria-invalid'] === true}
              name="assigneeUserId"
              people={assigneePeople(owners)}
              defaultValue={listed ? (item.assigneeUserId ?? '') : ''}
              // Not in the caller's list: the box still names the current assignee and posts nothing (kept).
              emptyStandsFor={current?.id}
              current={current}
              placeholder="Search by name"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

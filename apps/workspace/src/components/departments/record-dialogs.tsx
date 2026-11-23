'use client';

import { DEPARTMENT_NAME_MAX, DEPARTMENT_NAME_MIN } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';

import type { DepartmentRecordResult } from '@/app/(app)/settings/departments/action-types';
import {
  createDepartmentAction,
  loadRetireMembersAction,
  renameDepartmentAction,
  restoreDepartmentAction,
  retireDepartmentAction,
} from '@/app/(app)/settings/departments/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MemberPicker } from '@/components/ui/member-picker';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import styles from './departments.module.css';

// The department record's own save path (spec 5.2 path a): create, rename, retire and restore, each
// from its own dialog and guarded by the department's version.

export interface DepartmentRecord {
  id: string;
  name: string;
  version: number;
  status: 'active' | 'retired';
  /** Everyone in the department, the head and managers included. */
  members: number;
}

export interface StaffChoice {
  id: string;
  name: string;
  email: string | null;
  department: { id: string; name: string } | null;
}

export interface DepartmentChoice {
  id: string;
  name: string;
}

/** Value of the retire destination that means "leave them with no department". */
export const NO_DEPARTMENT = '__none__';

/** Client check of the name rules the API also enforces (2 to 60 characters). */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < DEPARTMENT_NAME_MIN) {
    return `Enter a name of at least ${DEPARTMENT_NAME_MIN} characters.`;
  }
  if (trimmed.length > DEPARTMENT_NAME_MAX) {
    return `Use at most ${DEPARTMENT_NAME_MAX} characters.`;
  }
  return null;
}

const people = (count: number) => (count === 1 ? '1 person' : `${count} people`);

const MEMBERS_NOT_LOADED = 'The people in this department could not be loaded.';

/** A stale or failed save, said inside the dialog, with Reload for the stale case. */
function Problem({
  result,
  onReload,
}: {
  result: DepartmentRecordResult | null;
  onReload: () => void;
}) {
  if (result === null || result.ok || result.fieldErrors !== undefined) return null;
  if (result.kind === 'membersChanged') {
    return (
      <Alert tone="warning" role="alert">
        {result.message}
      </Alert>
    );
  }
  if (result.kind === 'stale') {
    return (
      <Alert
        tone="warning"
        role="alert"
        actions={
          <Button variant="secondary" size="small" onClick={onReload}>
            Reload
          </Button>
        }
      >
        {result.message}
      </Alert>
    );
  }
  return (
    <Alert tone="error" role="alert">
      {result.message}
    </Alert>
  );
}

export function NewDepartmentDialog({
  staff,
  open,
  onOpenChange,
}: {
  staff: readonly StaffChoice[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const formId = useId();
  const [name, setName] = useState('');
  const [head, setHead] = useState('');
  const [headOpen, setHeadOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DepartmentRecordResult | null>(null);
  const nameError = result !== null && !result.ok ? result.fieldErrors?.name : undefined;
  const headError = result !== null && !result.ok ? result.fieldErrors?.headUserId : undefined;

  function change(next: boolean) {
    if (next) {
      setName('');
      setHead('');
      setResult(null);
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = nameProblem(name);
    if (problem !== null) {
      setResult({ ok: false, kind: 'invalid', message: problem, fieldErrors: { name: problem } });
      return;
    }
    setPending(true);
    const outcome = await createDepartmentAction({ name, headUserId: head === '' ? null : head });
    setPending(false);
    setResult(outcome);
    if (outcome.ok) {
      toast.success(`${outcome.name} created.`);
      onOpenChange(false);
      router.push(`/settings/departments/${outcome.id}`);
    } else if (outcome.fieldErrors === undefined) {
      toast.error(outcome.message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title="New department"
      size="small"
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
            Create
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <Field label="Name" error={nameError}>
          {(control) => (
            <Input
              {...control}
              name="name"
              value={name}
              required
              maxLength={DEPARTMENT_NAME_MAX}
              autoComplete="off"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          )}
        </Field>
        <Field
          label="Head"
          optional
          hint="The head sees all of this department's work."
          error={headError}
        >
          {(control) => (
            <MemberPicker
              labelledBy={control['aria-labelledby']}
              describedBy={control['aria-describedby']}
              invalid={control['aria-invalid'] === true}
              people={staff.map((person) => ({
                id: person.id,
                name: person.name,
                role: person.department !== null ? `Moves from ${person.department.name}` : null,
                searchText: person.email ?? '',
              }))}
              value={head}
              onChange={setHead}
              open={headOpen}
              onOpenChange={setHeadOpen}
              placeholder="No head"
              emptyText="No active people to choose from."
            />
          )}
        </Field>
        <Problem result={result} onReload={() => router.refresh()} />
      </form>
    </Dialog>
  );
}

export function RenameDepartmentDialog({
  department,
  open,
  onOpenChange,
}: {
  department: DepartmentRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const formId = useId();
  const [name, setName] = useState(department.name);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DepartmentRecordResult | null>(null);
  const nameError = result !== null && !result.ok ? result.fieldErrors?.name : undefined;

  function change(next: boolean) {
    if (next) {
      setName(department.name);
      setResult(null);
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = nameProblem(name);
    if (problem !== null) {
      setResult({ ok: false, kind: 'invalid', message: problem, fieldErrors: { name: problem } });
      return;
    }
    if (name.trim() === department.name) {
      onOpenChange(false);
      return;
    }
    setPending(true);
    const outcome = await renameDepartmentAction(department.id, name, department.version);
    setPending(false);
    setResult(outcome);
    if (outcome.ok) {
      toast.success(`Renamed to ${outcome.name}.`);
      onOpenChange(false);
      router.refresh();
    } else if (outcome.fieldErrors === undefined && outcome.kind !== 'stale') {
      toast.error(outcome.message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={`Rename ${department.name}`}
      size="small"
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <Field label="Name" error={nameError}>
          {(control) => (
            <Input
              {...control}
              name="name"
              value={name}
              required
              maxLength={DEPARTMENT_NAME_MAX}
              autoComplete="off"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          )}
        </Field>
        <Problem result={result} onReload={() => router.refresh()} />
      </form>
    </Dialog>
  );
}

export function RetireDepartmentDialog({
  department,
  destinations,
  open,
  onOpenChange,
}: {
  department: DepartmentRecord;
  /** Active departments the members may move to. */
  destinations: readonly DepartmentChoice[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [destination, setDestination] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DepartmentRecordResult | null>(null);
  // The active member ids this dialog shows and sends back, so nobody who joins after it opened is
  // moved unseen. Null while loading; reloaded after the API reports a changed list.
  const [memberIds, setMemberIds] = useState<readonly string[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const memberCount = memberIds?.length ?? department.members;
  const hasMembers = memberCount > 0;
  const fieldError = result !== null && !result.ok ? result.fieldErrors?.moveMembersTo : undefined;
  const ready = memberIds !== null && (!hasMembers || destination !== '');

  useEffect(() => {
    if (!open) return;
    let live = true;
    loadRetireMembersAction(department.id)
      .then((loaded) => {
        if (!live) return;
        if (loaded.ok) {
          setMemberIds(loaded.memberIds);
          setLoadProblem(null);
        } else {
          setLoadProblem(loaded.message);
        }
      })
      .catch(() => {
        // A failed request (say a dropped connection) gets the same retry as a refused load.
        if (live) setLoadProblem(MEMBERS_NOT_LOADED);
      });
    return () => {
      live = false;
    };
  }, [open, department.id, loads]);

  function change(next: boolean) {
    if (next) {
      setDestination('');
      setResult(null);
    } else {
      setMemberIds(null);
      setLoadProblem(null);
    }
    onOpenChange(next);
  }

  async function retire() {
    if (!ready || memberIds === null) return;
    setPending(true);
    const moveTo = !hasMembers ? undefined : destination === NO_DEPARTMENT ? null : destination;
    const outcome = await retireDepartmentAction(
      department.id,
      department.version,
      moveTo,
      memberIds,
    );
    setPending(false);
    setResult(outcome);
    if (outcome.ok) {
      toast.success(`${outcome.name} retired.`);
      onOpenChange(false);
      router.refresh();
    } else if (outcome.kind === 'membersChanged') {
      setMemberIds(null);
      setLoads((count) => count + 1);
    } else if (outcome.fieldErrors === undefined && outcome.kind !== 'stale') {
      toast.error(outcome.message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={`Retire ${department.name}?`}
      size="small"
      tone="destructive"
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={() => void retire()}
            disabled={pending || !ready}
            aria-busy={pending || undefined}
          >
            Retire
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        {hasMembers ? (
          <Field
            label={`Move ${people(memberCount)} to`}
            hint="A retired department keeps no members."
            error={fieldError}
          >
            {(control) => (
              <Select
                {...control}
                name="moveMembersTo"
                required
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              >
                <option value="">Choose a department</option>
                {destinations
                  .filter((choice) => choice.id !== department.id)
                  .map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.name}
                    </option>
                  ))}
                <option value={NO_DEPARTMENT}>No department</option>
              </Select>
            )}
          </Field>
        ) : (
          <p>No one is in {department.name}.</p>
        )}
        <p>Records stay under {department.name}. You can restore it later.</p>
        {loadProblem !== null && (
          <Alert
            tone="error"
            role="alert"
            actions={
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  setLoadProblem(null);
                  setLoads((count) => count + 1);
                }}
              >
                Try again
              </Button>
            }
          >
            {loadProblem}
          </Alert>
        )}
        <Problem result={result} onReload={() => router.refresh()} />
      </div>
    </Dialog>
  );
}

export function RestoreDepartmentDialog({
  department,
  open,
  onOpenChange,
}: {
  department: DepartmentRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Restore ${department.name}?`}
      description={`${department.name} becomes active again, with no members. Add its people after that.`}
      confirmLabel="Restore"
      onConfirm={async () => {
        const outcome = await restoreDepartmentAction(department.id, department.version);
        if (!outcome.ok) {
          toast.error(outcome.message);
          if (outcome.kind === 'stale') router.refresh();
          return false;
        }
        toast.success(`${outcome.name} restored.`);
        router.refresh();
        return true;
      }}
    />
  );
}

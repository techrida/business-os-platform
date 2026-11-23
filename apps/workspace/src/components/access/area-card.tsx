'use client';

import type {
  AccessAreaInfo,
  AccessCatalogueResponse,
  AccessRoleInfo,
  AssignmentHandOver,
  ManagerAssignmentRule,
  StaffAssignmentRule,
} from '@bos/contracts';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { Panel } from '@/components/ui/panel';
import { Select } from '@/components/ui/select';

import styles from './area-cards.module.css';
import {
  HEADS_LINE,
  MANAGERS_LINE,
  MANAGER_RULE_OPTIONS,
  MANAGER_RULE_TEXT,
  REACH_TEXT,
  STAFF_RULE_OPTIONS,
  STAFF_RULE_TEXT,
  STALE_MESSAGE,
  actionLabels,
  assignmentRuleFor,
  controlMatches,
  founderRole,
  onOff,
  peopleLabel,
  permissionInfo,
  reachChoices,
  reachHint,
  reachLabel,
  sameControl,
  scopeFromValue,
  splitByAccess,
  staffRoles,
  undoName,
  type AreaControl,
  type AreaDraft,
  type RefusedControl,
} from './by-area-model';
import { HandOversEditor, type DepartmentOption } from './hand-overs-editor';
import { LockIcon } from './lock-icon';
import { UndoButton } from './undo-button';
import { Checkbox } from '@/components/ui/checkbox';

export interface AreaCardProps {
  catalogue: AccessCatalogueResponse;
  area: AccessAreaInfo;
  open: boolean;
  /** The saved values (what the card shows closed, and what "dirty" compares with). */
  saved: AreaDraft;
  defaults: AreaDraft;
  /** The staged values while open; the saved values otherwise. */
  draft: AreaDraft;
  dirty: boolean;
  /** Staged values the server refused on save, with its reason; shown on their controls. */
  refused?: readonly RefusedControl[] | undefined;
  edited: boolean;
  canEdit: boolean;
  stale: boolean;
  departments: readonly DepartmentOption[] | null;
  onToggle: () => void;
  onDraft: (next: AreaDraft) => void;
  onUndo: (control: AreaControl) => void;
  onDiscard: () => void;
  onReview: () => void;
  onReload: () => void;
}

const lower = (text: string) => text.toLocaleLowerCase();

/** One area of Access > By area (spec 4): the summary when closed, the controls when open. */
export function AreaCard(props: AreaCardProps) {
  const { catalogue, area, open, edited, canEdit, onToggle } = props;
  const bodyId = useId();
  const assignmentSummary = catalogue.assignmentSummaries[area.key];
  const sentences = [
    ...(catalogue.summaries[area.key] ?? []),
    ...(assignmentSummary ? [assignmentSummary] : []),
  ];
  return (
    <Panel
      title={area.label}
      className={styles.card}
      actions={
        <div className={styles.cardActions}>
          {edited ? <Badge tone="info">Edited</Badge> : null}
          <Button
            variant="secondary"
            size="small"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            aria-label={`${open ? 'Close' : canEdit ? 'Edit' : 'View'} ${area.label}`}
            onClick={onToggle}
          >
            {open ? 'Close' : canEdit ? 'Edit' : 'View'}
          </Button>
        </div>
      }
    >
      {sentences.length > 0 ? (
        <ul className={styles.summary}>
          {sentences.map((sentence, index) => (
            <li key={`${index}:${sentence}`}>{sentence}</li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <div id={bodyId} className={styles.body}>
          <SeeBlock {...props} />
          <AssignBlock {...props} />
          {canEdit ? <Foot {...props} /> : null}
        </div>
      ) : null}
    </Panel>
  );
}

function SeeBlock(props: AreaCardProps) {
  const { catalogue, area, saved, canEdit, draft } = props;
  const headingId = useId();
  const founder = founderRole(catalogue);
  const { withAccess, withoutAccess } = splitByAccess(staffRoles(catalogue), saved);
  const noAccess = withoutAccess.length;
  const noAccessTitle = `${noAccess} ${noAccess === 1 ? 'role' : 'roles'} with no access`;
  const rows = (roles: readonly AccessRoleInfo[]) =>
    roles.map((role) => <RoleRow key={role.key} role={role} {...props} />);
  return (
    <section aria-labelledby={headingId} className={styles.block}>
      <h3 id={headingId} className={styles.blockTitle}>
        Who can see {lower(area.label)}
      </h3>
      <ul className={styles.roles}>
        {founder ? <FounderRow role={founder} area={area} /> : null}
        {rows(withAccess)}
      </ul>
      {withoutAccess.length > 0 ? (
        <Disclosure title={noAccessTitle}>
          <ul className={styles.roles}>{rows(withoutAccess)}</ul>
        </Disclosure>
      ) : null}
      {area.supportsDepartment ? (
        <div className={styles.levels}>
          <LevelLine
            {...props}
            control={{ type: 'managers' }}
            text={MANAGERS_LINE}
            checked={draft.managers}
            onCheck={(managers) => props.onDraft({ ...draft, managers })}
            disabled={!canEdit}
          />
          <LevelLine
            {...props}
            control={{ type: 'heads' }}
            text={HEADS_LINE}
            checked={draft.heads}
            onCheck={(heads) => props.onDraft({ ...draft, heads })}
            disabled={!canEdit}
          />
        </div>
      ) : null}
    </section>
  );
}

function undoFor(props: AreaCardProps, control: AreaControl, subject: string, text: string) {
  if (!props.canEdit || controlMatches(props.draft, props.defaults, control)) return null;
  return (
    <UndoButton
      name={undoName(subject, props.area.label, text)}
      onClick={() => props.onUndo(control)}
    />
  );
}

/** The server's reason when it refused the value this control holds. */
function refusalOf(props: AreaCardProps, control: AreaControl): string | undefined {
  return props.refused?.find((r) => sameControl(r.control, control))?.message;
}

/** `aria-describedby` for a control: its hint, plus the refusal when there is one. */
const describedBy = (ids: readonly (string | false | undefined)[]) =>
  ids.filter(Boolean).join(' ') || undefined;

function Refusal({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <span id={id} className={styles.error}>
      {message}
    </span>
  );
}

function FounderRow({ role, area }: { role: AccessRoleInfo; area: AccessAreaInfo }) {
  const hintId = useId();
  return (
    <li className={styles.roleRow}>
      <div className={styles.roleHead}>
        <span className={styles.roleName}>
          <LockIcon className={styles.lock ?? ''} />
          {role.label}
        </span>
        <span className={styles.count}>{peopleLabel(role.peopleCount)}</span>
      </div>
      <Select
        options={[{ value: 'all', label: REACH_TEXT.all.label }]}
        value="all"
        disabled
        aria-label={`${role.label} can see ${lower(area.label)}`}
        aria-describedby={hintId}
      />
      <span id={hintId} className={styles.hint}>
        Founders always have full access.
      </span>
    </li>
  );
}

function RoleRow(props: AreaCardProps & { role: AccessRoleInfo }) {
  const { catalogue, area, role, draft, canEdit, onDraft, defaults } = props;
  const hintId = useId();
  const errorId = useId();
  const refusal = refusalOf(props, { type: 'reach', role: role.key });
  const value = draft.reach[role.key] ?? null;
  const fallback = defaults.reach[role.key] ?? null;
  const actions = actionLabels(catalogue, area, role.key);
  return (
    <li className={styles.roleRow}>
      <div className={styles.roleHead}>
        <span className={styles.roleName}>{role.label}</span>
        <Link
          href={`/settings/users?role=${encodeURIComponent(role.key)}`}
          className={styles.count}
          aria-label={`${peopleLabel(role.peopleCount)} with the ${role.label} role`}
        >
          {peopleLabel(role.peopleCount)}
        </Link>
        {undoFor(props, { type: 'reach', role: role.key }, role.label, reachLabel(fallback))}
      </div>
      <Select
        options={reachChoices(permissionInfo(catalogue, area.seePermission), value)}
        value={value ?? ''}
        disabled={!canEdit}
        aria-label={`${role.label} can see ${lower(area.label)}`}
        aria-describedby={describedBy([hintId, refusal && errorId])}
        aria-invalid={refusal ? true : undefined}
        onChange={(event) =>
          onDraft({
            ...draft,
            reach: { ...draft.reach, [role.key]: scopeFromValue(event.target.value) },
          })
        }
      />
      <span id={hintId} className={styles.hint}>
        {reachHint(value)}
      </span>
      <Refusal id={errorId} message={refusal} />
      {actions.length > 0 ? (
        <p className={styles.alsoLine}>
          Can also: {actions.join(', ')}.{' '}
          <Link href={`/settings/access/roles/${encodeURIComponent(role.key)}`}>
            Change what {role.label} can do
          </Link>
        </p>
      ) : null}
    </li>
  );
}

function LevelLine(
  props: AreaCardProps & {
    control: AreaControl;
    text: string;
    checked: boolean;
    onCheck: (next: boolean) => void;
    disabled: boolean;
  },
) {
  const { control, text, checked, onCheck, disabled, defaults } = props;
  const fallback = control.type === 'managers' ? defaults.managers : defaults.heads;
  const errorId = useId();
  const refusal = refusalOf(props, control);
  return (
    <div className={styles.levelLine}>
      <div className={styles.levelRow}>
        <label className={styles.check}>
          <Checkbox
            checked={checked}
            disabled={disabled}
            aria-invalid={refusal ? true : undefined}
            aria-describedby={describedBy([refusal && errorId])}
            onCheckedChange={(nextChecked) => onCheck(nextChecked)}
          />
          <span>{text}</span>
        </label>
        {undoFor(props, control, `“${text}”`, onOff(fallback))}
      </div>
      <Refusal id={errorId} message={refusal} />
    </div>
  );
}

function AssignBlock(props: AreaCardProps) {
  const { catalogue, area, draft, canEdit, onDraft, departments } = props;
  const headingId = useId();
  const staffId = useId();
  const managersId = useId();
  const staffErrorId = useId();
  const managersErrorId = useId();
  const handOversErrorId = useId();
  const rule = assignmentRuleFor(catalogue, area);
  const fixed = catalogue.assignmentSummaries[area.key];

  if (!rule || !draft.assignment) {
    // Quotations: the read-only line (spec 4 and review R3). Other areas show nothing.
    if (!area.followsArea || !fixed) return null;
    return (
      <section aria-labelledby={headingId} className={styles.block}>
        <h3 id={headingId} className={styles.blockTitle}>
          Who can assign {lower(area.label)}
        </h3>
        <p className={styles.fixedLine}>{fixed}</p>
      </section>
    );
  }

  const assignment = draft.assignment;
  const staffRefusal = refusalOf(props, { type: 'staffRule' });
  const managersRefusal = refusalOf(props, { type: 'managerRule' });
  const handOversRefusal = refusalOf(props, { type: 'handOvers' });
  const known: AssignmentHandOver[] = [...rule.handOvers, ...rule.defaults.handOvers];
  const setAssignment = (patch: Partial<typeof assignment>) =>
    onDraft({ ...draft, assignment: { ...assignment, ...patch } });

  return (
    <section aria-labelledby={headingId} className={styles.block}>
      <h3 id={headingId} className={styles.blockTitle}>
        Who can assign {lower(area.label)}
      </h3>
      <RuleLine
        id={staffId}
        label="Staff can assign to"
        undo={undoFor(
          props,
          { type: 'staffRule' },
          'who staff can assign to',
          STAFF_RULE_TEXT[rule.defaults.staff],
        )}
      >
        <Select
          id={staffId}
          options={STAFF_RULE_OPTIONS}
          value={assignment.staff}
          disabled={!canEdit}
          aria-describedby={describedBy([staffRefusal && staffErrorId])}
          aria-invalid={staffRefusal ? true : undefined}
          onChange={(event) => setAssignment({ staff: event.target.value as StaffAssignmentRule })}
        />
        <Refusal id={staffErrorId} message={staffRefusal} />
      </RuleLine>
      <RuleLine
        id={managersId}
        label="Managers and heads can assign to"
        undo={undoFor(
          props,
          { type: 'managerRule' },
          'who managers and heads can assign to',
          MANAGER_RULE_TEXT[rule.defaults.managers],
        )}
      >
        <Select
          id={managersId}
          options={MANAGER_RULE_OPTIONS}
          value={assignment.managers}
          disabled={!canEdit}
          aria-describedby={describedBy([managersRefusal && managersErrorId])}
          aria-invalid={managersRefusal ? true : undefined}
          onChange={(event) =>
            setAssignment({ managers: event.target.value as ManagerAssignmentRule })
          }
        />
        <Refusal id={managersErrorId} message={managersRefusal} />
      </RuleLine>
      <HandOversEditor
        value={assignment.handOvers}
        known={known}
        departments={departments}
        disabled={!canEdit}
        onChange={(handOvers) => setAssignment({ handOvers })}
        undo={undoFor(props, { type: 'handOvers' }, 'hand-overs', 'the default hand-overs')}
      />
      <Refusal id={handOversErrorId} message={handOversRefusal} />
      <p className={styles.fixedLine}>
        <LockIcon className={styles.lock ?? ''} />
        Founders can assign to anyone. Nobody can assign to someone above their own level.
      </p>
      {area.key === 'leads' ? (
        <p className={styles.hint}>
          Opportunities, quotations and tasks on a lead follow the same rule.
        </p>
      ) : null}
    </section>
  );
}

function RuleLine({
  id,
  label,
  undo,
  children,
}: {
  id: string;
  label: string;
  undo: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.ruleLine}>
      <div className={styles.lineHead}>
        <label htmlFor={id} className={styles.lineLabel}>
          {label}
        </label>
        {undo}
      </div>
      {children}
    </div>
  );
}

function Foot({ dirty, stale, onDiscard, onReview, onReload }: AreaCardProps) {
  return (
    <div className={styles.foot}>
      <div className={styles.footStatus}>
        {stale ? (
          <Alert
            tone="warning"
            role="alert"
            actions={
              <Button variant="secondary" size="small" onClick={onReload}>
                Reload
              </Button>
            }
          >
            {STALE_MESSAGE}
          </Alert>
        ) : null}
      </div>
      <div className={styles.footButtons}>
        <Button variant="secondary" disabled={!dirty} onClick={onDiscard}>
          Discard
        </Button>
        <Button disabled={!dirty} onClick={onReview}>
          Review changes
        </Button>
      </div>
    </div>
  );
}

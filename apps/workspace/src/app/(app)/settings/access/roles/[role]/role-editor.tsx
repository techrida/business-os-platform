'use client';

import type { AccessChange, AccessRoleInfo, AccessScope, RoleKey } from '@bos/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useMemo, useState } from 'react';

import { ReviewChangesDialog } from '@/components/access/review-changes-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Panel } from '@/components/ui/panel';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';

import { previewAccessAction, saveAccessAction } from '../actions';
import { NOTHING_VALUE, peopleText, reachFromValue, reachHint, REACH_LABEL } from '../_lib/reach';
import {
  currentReach,
  differsFromDefault,
  filterGroups,
  grantChanges,
  rolePageHref,
  roleUsersHref,
  stageReach,
  undoLabel,
  type PermissionGroupView,
  type PermissionRow,
  type StagedReach,
} from '../_lib/role-model';
import { useLeaveGuard } from '../_lib/use-leave-guard';
import styles from '../roles.module.css';
import { Tooltip } from '@/components/ui/tooltip';

export const FOUNDER_LOCKED_MESSAGE = 'Founders always have full access. This cannot be changed.';
export const VIEW_ONLY_MESSAGE = 'Only a Founder can change access.';
const STALE_MESSAGE = 'Access was changed by someone else. Reload to see the latest.';
const SEPARATION_NOTE = 'Cannot be the person who prepared it.';

export interface RoleEditorProps {
  role: AccessRoleInfo;
  /** Every role, in list order, for the "Role" select shown on narrow screens. */
  roles: readonly { key: RoleKey; label: string }[];
  groups: readonly PermissionGroupView[];
  /** Any saved value of this role differs from its default. */
  edited: boolean;
  canWrite: boolean;
  /** The access revision the page loaded; a save sends it so a newer change refuses it. */
  revision: string;
}

interface Review {
  changes: AccessChange[];
}

function PermissionControl({
  row,
  roleLabel,
  value,
  readOnly,
  showUndo,
  onChange,
  onUndo,
}: {
  row: PermissionRow;
  roleLabel: string;
  value: AccessScope | null;
  readOnly: boolean;
  showUndo: boolean;
  onChange: (next: AccessScope | null) => void;
  onUndo: () => void;
}) {
  const base = useId();
  const controlId = `${base}-control`;
  const notes = [
    row.separationOfDuties ? SEPARATION_NOTE : null,
    row.kind === 'portal' ? REACH_LABEL.customer_org : null,
    row.risk,
  ].filter((note): note is string => note !== null);
  const noteIds = notes.map((_, i) => `${base}-note-${i}`);
  const hintId = `${base}-hint`;
  const describedBy =
    [...noteIds, row.control === 'select' ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <li className={styles.row}>
      <div className={styles.rowText}>
        <label htmlFor={controlId} className={styles.rowLabel}>
          {row.label}
        </label>
        {notes.map((note, i) => (
          <p key={note} id={noteIds[i]} className={styles.note}>
            {note}
          </p>
        ))}
      </div>
      <div className={styles.rowControl}>
        {row.control === 'select' ? (
          <>
            <Select
              id={controlId}
              options={row.options}
              value={value ?? NOTHING_VALUE}
              disabled={readOnly}
              aria-describedby={describedBy}
              onChange={(event) => onChange(reachFromValue(event.target.value, row.offered))}
            />
            <p id={hintId} className={styles.hint}>
              {reachHint(value)}
            </p>
          </>
        ) : (
          <span className={styles.rowToggle}>
            <input
              id={controlId}
              type="checkbox"
              className={styles.checkbox}
              checked={value !== null}
              disabled={readOnly || row.onValue === null}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.checked ? row.onValue : null)}
            />
          </span>
        )}
      </div>
      <div className={styles.undoSlot}>
        {showUndo ? (
          <Tooltip content={undoLabel(roleLabel, row)}>
            <button
              type="button"
              className={styles.undo}
              aria-label={undoLabel(roleLabel, row)}
              onClick={onUndo}
            >
              <Icon name="undo-2" size={16} />
            </button>
          </Tooltip>
        ) : null}
      </div>
    </li>
  );
}

/**
 * One role's permissions (spec 6.1): a panel per group in catalogue order, a reach select or a
 * checkbox per permission, "Find a permission", "Only show what this role can do", the undo icon per
 * changed value and one foot bar. Nothing is written until the review dialog's Save: "Review
 * changes", an undo icon and "Reset to defaults" all open it with their changes.
 */
export function RoleEditor({ role, roles, groups, edited, canWrite, revision }: RoleEditorProps) {
  const router = useRouter();
  const [staged, setStaged] = useState<StagedReach>({});
  const [query, setQuery] = useState('');
  const [onlyGranted, setOnlyGranted] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [stale, setStale] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);

  const founder = role.kind === 'founder' || role.locked;
  const readOnly = founder || !canWrite;
  const changes = useMemo(() => grantChanges(role.key, groups, staged), [role.key, groups, staged]);
  const dirty = changes.length > 0;
  const visible = filterGroups(groups, staged, { query, onlyGranted });
  const shownRows = visible.reduce((sum, group) => sum + group.rows.length, 0);
  const anyDiffersFromDefault = groups.some((g) =>
    g.rows.some((r) => differsFromDefault(r, staged)),
  );
  const title = `Review changes to the ${role.label} role`;

  const attemptLeave = useCallback((href: string) => setLeaveTo(href), []);
  useLeaveGuard(dirty && !readOnly, attemptLeave);

  const go = (href: string) => {
    if (dirty && !readOnly) setLeaveTo(href);
    else router.push(href);
  };

  const undo = (row: PermissionRow) => {
    // With unsaved edits the icon only puts this control back; otherwise it reviews the one reset.
    if (dirty) {
      setStaged(stageReach(staged, row, row.defaultScope));
      return;
    }
    setReview({
      changes: [
        { kind: 'grant', role: role.key, permission: row.permission, scope: row.defaultScope },
      ],
    });
  };

  return (
    <div className={styles.main}>
      <div className={styles.picker}>
        <Field label="Role">
          {(control) => (
            <Select
              {...control}
              options={roles.map((r) => ({ value: r.key, label: r.label }))}
              value={role.key}
              onChange={(event) => {
                if (event.target.value !== role.key) {
                  go(rolePageHref(event.target.value as RoleKey));
                }
              }}
            />
          )}
        </Field>
      </div>

      <div className={styles.roleHead}>
        <div className={styles.roleHeadText}>
          <h2 className={styles.roleTitle}>{role.label}</h2>
          <p className={styles.roleDescription}>{role.description}</p>
          <Link href={roleUsersHref(role.key)} className={styles.peopleLink}>
            {peopleText(role.peopleCount)}
          </Link>
        </div>
        {readOnly ? null : (
          <Button
            variant="secondary"
            disabled={!(edited || anyDiffersFromDefault)}
            onClick={() => setReview({ changes: [{ kind: 'resetRole', role: role.key }] })}
          >
            Reset to defaults
          </Button>
        )}
      </div>

      {founder ? (
        <Alert tone="info">{FOUNDER_LOCKED_MESSAGE}</Alert>
      ) : !canWrite ? (
        <Alert tone="info">{VIEW_ONLY_MESSAGE}</Alert>
      ) : null}

      <div className={styles.tools}>
        <Field label="Find a permission" className={styles.find ?? ''}>
          {(control) => (
            <SearchInput
              {...control}
              value={query}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
        </Field>
        <label className={styles.check}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={onlyGranted}
            onChange={(event) => setOnlyGranted(event.target.checked)}
          />
          Only show what this role can do
        </label>
      </div>
      <p className="sr-only" role="status">
        {shownRows === 1 ? '1 permission shown' : `${shownRows} permissions shown`}
      </p>

      {visible.length === 0 ? (
        <EmptyState title="No permission matches" icon="search" headingLevel={3}>
          Try other words, or show every permission.
        </EmptyState>
      ) : (
        visible.map((group) => (
          <Panel key={group.key} id={group.key} title={group.label} headingLevel={3}>
            <ul className={styles.rows}>
              {group.rows.map((row) => (
                <PermissionControl
                  key={row.permission}
                  row={row}
                  roleLabel={role.label}
                  value={currentReach(row, staged)}
                  readOnly={readOnly}
                  showUndo={!readOnly && differsFromDefault(row, staged)}
                  onChange={(next) => {
                    setStaged(stageReach(staged, row, next));
                    setStale(false);
                  }}
                  onUndo={() => undo(row)}
                />
              ))}
            </ul>
          </Panel>
        ))
      )}

      {readOnly ? null : (
        <div className={styles.foot}>
          {stale ? (
            <Alert
              tone="warning"
              role="alert"
              actions={
                <Button variant="secondary" size="small" onClick={() => router.refresh()}>
                  Reload
                </Button>
              }
            >
              {STALE_MESSAGE}
            </Alert>
          ) : null}
          <div className={styles.footButtons}>
            <Button
              variant="secondary"
              disabled={!dirty}
              onClick={() => {
                setStaged({});
                setStale(false);
              }}
            >
              Discard
            </Button>
            <Button disabled={!dirty} onClick={() => setReview({ changes })}>
              Review changes
            </Button>
          </div>
        </div>
      )}

      {readOnly ? null : (
        <ReviewChangesDialog
          open={review !== null}
          onOpenChange={(open) => {
            if (!open) setReview(null);
          }}
          title={title}
          changes={review?.changes ?? []}
          expectedRevision={revision}
          runPreview={(next) => previewAccessAction(next)}
          runSave={({ acknowledged, note }) =>
            saveAccessAction({
              changes: review?.changes ?? [],
              expectedRevision: revision,
              acknowledged,
              note,
            })
          }
          onSaved={() => {
            setReview(null);
            setStaged({});
            setStale(false);
            router.refresh();
          }}
          onStale={() => {
            setReview(null);
            setStale(true);
          }}
        />
      )}

      <ConfirmDialog
        open={leaveTo !== null}
        onOpenChange={(open) => {
          if (!open) setLeaveTo(null);
        }}
        title={`Discard your changes to the ${role.label} role?`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          const href = leaveTo;
          setStaged({});
          setLeaveTo(null);
          if (href) router.push(href);
        }}
      />
    </div>
  );
}

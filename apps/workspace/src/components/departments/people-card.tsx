'use client';

import {
  ACCESS_LEVELS,
  DEPARTMENT_JOB_TITLE_MAX,
  type AccessLevel,
  type AdminDepartmentDetail,
} from '@bos/contracts';
import { formatKathmandu } from '@bos/locale';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  previewDepartmentPeopleAction,
  saveDepartmentPeopleAction,
} from '@/app/(app)/settings/departments/actions';
import { roleLabel } from '@/app/(app)/settings/users/role-checkboxes';
import { ReviewChangesDialog } from '@/components/access/review-changes-dialog';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Field, Input, Select } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { MultiSelect } from '@/components/ui/multi-select';
import { Panel } from '@/components/ui/panel';

import { ActionMenu } from './action-menu';
import styles from './departments.module.css';
import {
  addPeople,
  buildDepartmentChanges,
  filterPeople,
  headOf,
  initialPeopleState,
  keepPerson,
  LEVEL_LABEL,
  LEVEL_OPTIONS,
  movePeople,
  recordNotices,
  removePeople,
  setHead,
  setJobTitle,
  setLevel,
  setLevelMany,
  tooManyChanges,
  type DepartmentRef,
  type PersonCandidate,
  type StagedPerson,
} from './people-model';

export const PEOPLE_STALE_MESSAGE = 'Access was changed by someone else. Reload to see the latest.';

const LEVEL_FILTER_OPTIONS = LEVEL_OPTIONS.map(({ value, label }) => ({ value, label }));

function since(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : formatKathmandu(date, 'date');
}

/** Keeps the members search and Level filter in the URL without a server round trip. */
function writeFilterUrl(query: string, levels: readonly AccessLevel[]) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (query.trim() === '') url.searchParams.delete('mq');
  else url.searchParams.set('mq', query);
  url.searchParams.delete('level');
  for (const level of levels) url.searchParams.append('level', level);
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

function readLevels(values: readonly string[]): AccessLevel[] {
  return ACCESS_LEVELS.filter((level) => values.includes(level));
}

function PersonCell({ person, departmentName }: { person: StagedPerson; departmentName: string }) {
  return (
    <span className={styles.person}>
      <Avatar name={person.name} size="small" shape="circle" />
      <span className={styles.personText}>
        <span className={styles.name}>{person.name}</span>
        {person.email && <span className={styles.email}>{person.email}</span>}
        {person.origin === 'added' && (
          <span className={styles.email}>
            {person.fromDepartment !== null
              ? `Moves from ${person.fromDepartment.name}`
              : `Joins ${departmentName}`}
          </span>
        )}
        {person.leaving?.kind === 'remove' && <Badge tone="warning">Leaving</Badge>}
        {person.leaving?.kind === 'move' && (
          <Badge tone="warning">{`Moves to ${person.leaving.to.name}`}</Badge>
        )}
      </span>
    </span>
  );
}

export function PeopleCard({
  detail,
  staff,
  destinations,
  canWrite,
}: {
  detail: AdminDepartmentDetail;
  /** Active people who may be added (empty when the viewer may not list users). */
  staff: readonly PersonCandidate[];
  /** Active departments, for "Move to department". */
  destinations: readonly DepartmentRef[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initial = useMemo(() => initialPeopleState(detail), [detail]);
  const [staged, setStaged] = useState(initial);
  const [query, setQuery] = useState(searchParams?.get('mq') ?? '');
  const [levels, setLevels] = useState<AccessLevel[]>(() =>
    readLevels(searchParams?.getAll('level') ?? []),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [headOpen, setHeadOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [stale, setStale] = useState(false);

  const name = detail.name;
  const editable = canWrite && detail.status === 'active';
  const changes = useMemo(() => buildDepartmentChanges(initial, staged), [initial, staged]);
  const dirty = changes.length > 0;
  const tooMany = tooManyChanges(changes);
  const head = headOf(staged);
  const shown = filterPeople(staged.people, query, levels);
  const notices = recordNotices(staged);
  const others = destinations.filter((d) => d.id !== detail.id);
  const listed = new Set(staged.people.map((person) => person.userId));
  const selectedIds = [...selected].filter((id) => listed.has(id));

  function updateFilters(nextQuery: string, nextLevels: AccessLevel[]) {
    setQuery(nextQuery);
    setLevels(nextLevels);
    writeFilterUrl(nextQuery, nextLevels);
  }

  function toggle(userId: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  const clearSelection = () => setSelected(new Set());

  const headOptions = staged.people
    .filter((person) => person.leaving === null)
    .map((person) => ({
      id: person.userId,
      label: person.name,
      searchText: person.email ?? '',
      ...(person.email !== null ? { description: person.email } : {}),
    }));

  const addOptions = staff
    .filter((candidate) => !listed.has(candidate.id))
    .map((candidate) => ({
      id: candidate.id,
      label: candidate.name,
      searchText: candidate.email ?? '',
      ...(candidate.department !== null && candidate.department.id !== detail.id
        ? { description: `Moves from ${candidate.department.name}` }
        : candidate.email !== null
          ? { description: candidate.email }
          : {}),
    }));

  const emptyText = `No one is in ${name} yet. Add people to get started.`;

  return (
    <Panel title="People" description="Who works here, their level and the department head.">
      <div className={styles.people}>
        {editable ? (
          <Field label="Department head" hint="The head sees all of this department's work.">
            {(control) => (
              <Combobox
                labelledBy={control['aria-labelledby']}
                describedBy={control['aria-describedby']}
                options={headOptions}
                value={head?.userId ?? ''}
                onChange={(id) => setStaged((current) => setHead(current, id === '' ? null : id))}
                open={headOpen}
                onOpenChange={setHeadOpen}
                placeholder="No head"
                emptyText="Add people first."
              />
            )}
          </Field>
        ) : (
          <p>
            <span className={styles.muted}>Department head: </span>
            {head?.name ?? 'No head'}
          </p>
        )}

        <div className={styles.toolbar}>
          {editable && (
            <Field label="Add people" hint="Someone in another department moves here.">
              {(control) => (
                <Combobox
                  labelledBy={control['aria-labelledby']}
                  describedBy={control['aria-describedby']}
                  options={addOptions}
                  value=""
                  onChange={(id) => {
                    const candidate = staff.find((person) => person.id === id);
                    if (candidate !== undefined) {
                      setStaged((current) => addPeople(current, [candidate]));
                    }
                  }}
                  open={addOpen}
                  onOpenChange={setAddOpen}
                  placeholder="Search people"
                  emptyText="Everyone is already here."
                />
              )}
            </Field>
          )}
          <Field label="Search members">
            {(control) => (
              <Input
                {...control}
                type="search"
                value={query}
                autoComplete="off"
                onChange={(event) => updateFilters(event.currentTarget.value, levels)}
              />
            )}
          </Field>
          <MultiSelect
            name="level"
            label="Level"
            options={LEVEL_FILTER_OPTIONS}
            value={levels}
            onChange={(values) => updateFilters(query, readLevels(values))}
            allLabel="All levels"
            pluralLabel="levels"
            className={styles.toolbarFilter ?? ''}
          />
        </div>

        <p className="sr-only" role="status">
          {`${shown.length} of ${staged.people.length} people shown`}
        </p>

        {staged.people.length === 0 ? (
          <p className={styles.muted}>{emptyText}</p>
        ) : shown.length === 0 ? (
          <p className={styles.muted}>No member matches this search.</p>
        ) : (
          <table className={styles.memberTable}>
            <caption className="sr-only">{`Members of ${name}`}</caption>
            <thead>
              <tr>
                {editable && (
                  <th scope="col" className={styles.cellSelect}>
                    <span className="sr-only">Select</span>
                  </th>
                )}
                <th scope="col" className={styles.cellPerson}>
                  Person
                </th>
                <th scope="col" className={styles.cellTitle}>
                  Job title
                </th>
                <th scope="col" className={styles.cellLevel}>
                  Level
                </th>
                <th scope="col" className={styles.cellRoles}>
                  Roles
                </th>
                <th scope="col" className={styles.cellSince}>
                  Since
                </th>
                {editable && (
                  <th scope="col" className={styles.cellRemove}>
                    <span className="sr-only">Remove</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((person) => {
                const leaving = person.leaving !== null;
                const rowControls = editable && !leaving;
                return (
                  <tr key={person.userId} className={leaving ? styles.leaving : undefined}>
                    {editable && (
                      <td className={styles.cellSelect}>
                        <input
                          type="checkbox"
                          className={styles.checkbox}
                          aria-label={`Select ${person.name}`}
                          checked={selected.has(person.userId)}
                          disabled={leaving}
                          onChange={(event) => toggle(person.userId, event.currentTarget.checked)}
                        />
                      </td>
                    )}
                    <th scope="row" className={styles.cellPerson}>
                      <PersonCell person={person} departmentName={name} />
                    </th>
                    <td className={styles.cellTitle}>
                      <Input
                        aria-label={`Job title for ${person.name}`}
                        value={person.jobTitle}
                        maxLength={DEPARTMENT_JOB_TITLE_MAX}
                        placeholder="No job title"
                        disabled={!rowControls}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setStaged((current) => setJobTitle(current, person.userId, value));
                        }}
                      />
                    </td>
                    <td className={styles.cellLevel}>
                      <Select
                        aria-label={`Level for ${person.name}`}
                        name={`level-${person.userId}`}
                        value={person.level}
                        disabled={!rowControls}
                        options={LEVEL_OPTIONS}
                        onChange={(event) => {
                          const level = ACCESS_LEVELS.find((l) => l === event.target.value);
                          if (level !== undefined) {
                            setStaged((current) => setLevel(current, person.userId, level));
                          }
                        }}
                      />
                    </td>
                    <td className={styles.cellRoles}>
                      {person.roles.length > 0 ? (
                        <ul className={styles.roles} aria-label={`Roles of ${person.name}`}>
                          {person.roles.map((role) => (
                            <li key={role}>
                              <Badge>{roleLabel(role)}</Badge>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className={styles.muted}>No roles</span>
                      )}
                      {person.email && (
                        <Link
                          href={`/settings/users?q=${encodeURIComponent(person.email)}`}
                          className={styles.link}
                          aria-label={`Change roles for ${person.name}`}
                        >
                          Change roles
                        </Link>
                      )}
                    </td>
                    <td className={styles.cellSince}>
                      {person.since !== null ? (
                        <time dateTime={person.since}>{since(person.since)}</time>
                      ) : (
                        <span className={styles.muted}>New</span>
                      )}
                    </td>
                    {editable && (
                      <td className={styles.cellRemove}>
                        {leaving ? (
                          <Button
                            variant="tertiary"
                            size="small"
                            aria-label={`Keep ${person.name} in ${name}`}
                            onClick={() =>
                              setStaged((current) => keepPerson(current, person.userId))
                            }
                          >
                            Keep
                          </Button>
                        ) : (
                          <>
                            <span className={styles.wide}>
                              <Button
                                variant="ghost"
                                size="small"
                                className={styles.iconButton}
                                aria-label={`Remove ${person.name} from ${name}`}
                                title={`Remove ${person.name} from ${name}`}
                                onClick={() =>
                                  setStaged((current) => removePeople(current, [person.userId]))
                                }
                              >
                                <Icon name="x" size={18} />
                              </Button>
                            </span>
                            <span className={styles.narrow}>
                              <ActionMenu
                                label={`More actions for ${person.name}`}
                                items={[
                                  {
                                    label: `Remove ${person.name} from ${name}`,
                                    onSelect: () =>
                                      setStaged((current) =>
                                        removePeople(current, [person.userId]),
                                      ),
                                  },
                                ]}
                              />
                            </span>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {editable && selectedIds.length > 0 && (
          <div className={styles.bulkBar} role="region" aria-label="Selected people">
            <p className={styles.bulkCount}>{`${selectedIds.length} selected`}</p>
            <Select
              aria-label="Set level for the selected people"
              value=""
              required
              onChange={(event) => {
                const level = event.target.value;
                if (level !== 'staff' && level !== 'manager') return;
                setStaged((current) => setLevelMany(current, selectedIds, level));
                clearSelection();
              }}
            >
              <option value="">Set level</option>
              <option value="staff">{LEVEL_LABEL.staff}</option>
              <option value="manager">{LEVEL_LABEL.manager}</option>
            </Select>
            {others.length > 0 && (
              <Select
                aria-label="Move the selected people to a department"
                value=""
                required
                onChange={(event) => {
                  const to = others.find((d) => d.id === event.target.value);
                  if (to === undefined) return;
                  setStaged((current) => movePeople(current, selectedIds, to));
                  clearSelection();
                }}
              >
                <option value="">Move to department</option>
                {others.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setStaged((current) => removePeople(current, selectedIds));
                clearSelection();
              }}
            >
              Remove
            </Button>
            <Button variant="ghost" onClick={clearSelection}>
              Clear selection
            </Button>
          </div>
        )}

        {editable && (
          <div className={styles.foot}>
            <div className={styles.footStatus}>
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
                  {PEOPLE_STALE_MESSAGE}
                </Alert>
              ) : tooMany ? (
                <Alert tone="warning" role="status">
                  {`Save at most 100 changes at a time. You have ${changes.length}.`}
                </Alert>
              ) : notices.length > 0 ? (
                <ul className={styles.notices} aria-label="Before you save">
                  {notices.map((notice) => (
                    <li key={notice}>{notice}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className={styles.footButtons}>
              <Button
                variant="secondary"
                disabled={!dirty}
                onClick={() => {
                  setStaged(initial);
                  clearSelection();
                  setStale(false);
                }}
              >
                Discard
              </Button>
              <Button disabled={!dirty || tooMany} onClick={() => setReviewOpen(true)}>
                Review changes
              </Button>
            </div>
          </div>
        )}
      </div>

      {editable && dirty && (
        <ReviewChangesDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          title={`Review changes to ${name}`}
          changes={changes}
          expectedRevision={detail.revision}
          runPreview={(next) => previewDepartmentPeopleAction(next)}
          runSave={({ acknowledged, note }) =>
            saveDepartmentPeopleAction(detail.id, {
              changes,
              expectedRevision: detail.revision,
              acknowledged: [...acknowledged],
              note,
            })
          }
          onSaved={() => {
            setReviewOpen(false);
            router.refresh();
          }}
          onStale={() => {
            setReviewOpen(false);
            setStale(true);
          }}
        />
      )}
    </Panel>
  );
}

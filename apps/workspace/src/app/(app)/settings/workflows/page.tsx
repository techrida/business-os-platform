import { SETTING_DEFAULTS, SlaSpecSchema } from '@bos/contracts';

import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import {
  getApprovalSlaDefaults,
  listApprovalGroups,
  listDelegations,
  listApprovalPeople,
  listWorkflows,
  type WorkflowVersion,
} from '@/lib/api-admin';

import { userNames } from '@/lib/business-labels';
import { getPermissionCheck } from '@/lib/live-permissions';

import adminStyles from '../admin.module.css';
import { BackToSettings } from '../_components/back-link';
import { loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import { SettingsForm } from '../_components/settings-form';
import { formatInstant } from '../format';
import { requireSection } from '../guard';
import { section, type Section } from '../section';
import { Notice, SectionError } from '../ui';
import {
  createWorkflowAction,
  deleteGroupAction,
  publishVersionAction,
  removeMemberAction,
  revokeDelegationAction,
  saveDraftAction,
} from './actions';
import {
  AddMemberForm,
  ActionButton,
  CreateGroupForm,
  DelegationForm,
  SoleEligiblePublishForm,
} from './panels';
import { SpecSummary } from './spec-summary';
import type { UserOption } from './user-field';
import { WorkflowEditor } from './workflow-editor';
import styles from './workflows.module.css';

const STATUS: Record<
  WorkflowVersion['status'],
  { tone: 'warning' | 'success' | 'neutral'; label: string }
> = {
  draft: { tone: 'warning', label: 'Draft' },
  published: { tone: 'success', label: 'Published' },
  retired: { tone: 'neutral', label: 'Retired' },
};

/**
 * An initials avatar, the name, and the email under it. The avatar is decoration; its colour is
 * seeded from the user id so the person matches their avatar on other screens.
 */
function Person({
  userId,
  name,
  email,
  unknown = false,
}: {
  userId: string;
  name: string;
  email: string | null;
  unknown?: boolean;
}) {
  return (
    <div className={styles.person}>
      <Avatar name={unknown ? '' : name} seedId={userId} shape="circle" />
      <span className={styles.personText}>
        <span className={styles.personName}>{name}</span>
        {email ? <span className={styles.personEmail}>{email}</span> : null}
      </span>
    </div>
  );
}

function SectionHead({ id, title, children }: { id: string; title: string; children?: string }) {
  return (
    <div className={styles.sectionHead}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {children ? <p className={styles.sectionIntro}>{children}</p> : null}
    </div>
  );
}

/** A section the viewer's grants do not open: not fetched, and not shown. */
const NOT_GRANTED = { ok: false as const, message: '' };

/**
 * What the Action cell of a draft says. Publishing needs a second person (F1-Q11): a Management member other than
 * whoever saved the draft. The API enforces it; this only explains it instead of offering a button that fails.
 */
function draftPublishBlock(v: WorkflowVersion, canPublish: boolean): string | null {
  if (v.createdBy === null) {
    return 'Saved before publishing needed a second person. Save it again as a new draft to publish it.';
  }
  if (v.savedByCaller) return 'You saved this draft, so another Management member publishes it.';
  if (!canPublish) return 'Waiting for a Management member other than its editor to publish it.';
  return null;
}

export default async function WorkflowsPage() {
  const session = await requireSection('workflows');
  const can = await getPermissionCheck(session);
  const canEdit = can('approvals.definitions.write');
  const canPublish = can('approvals.definitions.publish');
  const canGroups = can('approvals.groups.write');
  const canDelegations = can('approvals.delegations.write');
  const granted = <T,>(allowed: boolean, load: () => Promise<Section<T>>): Promise<Section<T>> =>
    allowed ? load() : Promise.resolve(NOT_GRANTED);

  // Each picker uses its own management permission; a failed lookup never discards saved targets.
  const [
    workflows,
    groups,
    delegations,
    users,
    groupPeople,
    delegationPeople,
    directoryNames,
    timing,
    savedSla,
  ] = await Promise.all([
    section('view workflows', () => listWorkflows(session)),
    granted(canGroups, () => section('manage approval groups', () => listApprovalGroups(session))),
    granted(canDelegations, () => section('manage delegations', () => listDelegations(session))),
    granted(canEdit, () =>
      section('choose workflow approvers', () => listApprovalPeople(session, 'workflows')),
    ),
    granted(canGroups, () =>
      section('choose group members', () => listApprovalPeople(session, 'approval-groups')),
    ),
    granted(canDelegations, () =>
      section('choose delegation people', () => listApprovalPeople(session, 'delegations')),
    ),
    userNames(session),
    canEdit ? loadFields(session, ['approvals.sla_defaults']) : Promise.resolve(NOT_GRANTED),
    // Its own route: workflow editors may read these times without the settings admin permission.
    granted(canEdit, () =>
      section('view the default reminder times', () => getApprovalSlaDefaults(session)),
    ),
  ]);

  // A new workflow starts from the saved default times. A read that failed, or a stored value this
  // screen cannot read, falls back to the built-in default, as the API does.
  const parsedSla = savedSla.ok ? SlaSpecSchema.safeParse(savedSla.data.value) : null;
  const slaDefaults = parsedSla?.success
    ? parsedSla.data
    : SETTING_DEFAULTS['approvals.sla_defaults'];

  const options = (people: typeof users): UserOption[] | null =>
    people.ok
      ? people.data.map((u) => {
          // D54-2: no display name reads "Unnamed user"; the address is shown beside it, never as the name.
          const name = u.displayName?.trim() || 'Unnamed user';
          return {
            id: u.id,
            label: u.email ? `${name} (${u.email})` : name,
            name,
            email: u.email ?? null,
          };
        })
      : null;
  const userOptions = options(users);
  const groupOptions = options(groupPeople);
  const delegationOptions = options(delegationPeople);
  const peopleOptions = [
    ...(userOptions ?? []),
    ...(groupOptions ?? []),
    ...(delegationOptions ?? []),
  ];
  const optionOf = (id: string): UserOption | undefined => peopleOptions.find((u) => u.id === id);
  const labelOf = (id: string): string =>
    optionOf(id)?.label ?? directoryNames.get(id) ?? 'Name unavailable';
  const personOf = (id: string) => {
    const option = optionOf(id);
    return option
      ? { userId: id, name: option.name, email: option.email, unknown: false }
      : {
          userId: id,
          name: directoryNames.get(id) ?? 'Name unavailable',
          email: null,
          unknown: !directoryNames.has(id),
        };
  };

  const groupKeys = groups.ok ? groups.data.map((g) => g.key) : [];
  const documentTypes = workflows.ok ? [...new Set(workflows.data.map((w) => w.documentType))] : [];

  return (
    <Page className={adminStyles.page}>
      <BackToSettings />
      <PageHeader
        title="Workflows"
        description="Manage approval routes, groups and delegations. Submitted requests keep the workflow version they started with."
      />

      <nav aria-label="On this page" className={styles.jump}>
        {canEdit ? <a href="#timing">Reminder times</a> : null}
        <a href="#workflows">Workflows</a>
        {canGroups ? <a href="#groups">Approval groups</a> : null}
        {canDelegations ? <a href="#delegations">Delegations</a> : null}
      </nav>

      {/* ---- default reminder and escalation times -------------------------------------------- */}
      {canEdit ? (
        <div id="timing" className={styles.section}>
          {timing.ok ? (
            (() => {
              const timingFields = timing.data.map((field) => ({
                ...field,
                label: 'Default timing',
              }));
              return (
                <SettingsForm section="workflows" fields={timingFields}>
                  <SettingCard
                    title="Default reminder and escalation times"
                    description="Used by a workflow that does not set its own times."
                    fields={timingFields}
                  />
                </SettingsForm>
              );
            })()
          ) : (
            <SectionError message={timing.message} />
          )}
        </div>
      ) : null}

      {/* ---- workflows ------------------------------------------------------------------------- */}
      <section className={styles.section} id="workflows" aria-labelledby="wf-heading">
        <SectionHead id="wf-heading" title="Workflow definitions">
          A workflow decides who approves money, so it takes two people: one saves a draft, and a
          Management member other than that person publishes it.
        </SectionHead>

        {!workflows.ok ? (
          <SectionError message={workflows.message} />
        ) : (
          <>
            {workflows.data.length === 0 ? (
              <EmptyState title="No workflows yet." headingLevel={3}>
                {canEdit ? 'Create the first one below.' : null}
              </EmptyState>
            ) : (
              <ul className={styles.list}>
                {workflows.data.map((wf) => {
                  const latest = wf.versions.at(-1);
                  const current = wf.versions.find((v) => v.id === wf.currentVersionId);
                  const versionsDesc = [...wf.versions].reverse();
                  return (
                    <li key={wf.id}>
                      <article className={styles.workflow} aria-labelledby={`wf-${wf.id}`}>
                        <div className={styles.workflowHead}>
                          <h3 id={`wf-${wf.id}`} className={styles.workflowTitle}>
                            {wf.name}
                          </h3>
                          <span className={styles.workflowMeta}>
                            <span className={styles.mono}>{wf.key}</span> for{' '}
                            <span className={styles.mono}>{wf.documentType}</span>
                          </span>
                        </div>
                        <p className={styles.inUse}>
                          {current
                            ? `In use: version ${current.version}.`
                            : 'Not in use yet: publish a draft to start using this workflow.'}
                        </p>

                        <Table
                          caption={`Versions of ${wf.name}`}
                          className={adminStyles.local ?? ''}
                          minWidth={520}
                        >
                          <thead>
                            <tr>
                              <Th>Version</Th>
                              <Th>Status</Th>
                              <Th>Published</Th>
                              <Th>Action</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {versionsDesc.map((v) => (
                              <tr key={v.id}>
                                <Th scope="row" className={adminStyles.rowHead}>
                                  <span className={styles.versionName}>Version {v.version}</span>
                                  {v.createdBy ? (
                                    <span className={styles.hint}>
                                      Saved by {v.createdByName ?? labelOf(v.createdBy)}
                                    </span>
                                  ) : null}
                                  <details className={styles.specToggle}>
                                    <summary>
                                      View spec
                                      <span className="sr-only"> of version {v.version}</span>
                                    </summary>
                                    <div className={styles.specBody}>
                                      <SpecSummary
                                        spec={v.spec}
                                        people={Object.fromEntries([
                                          ...directoryNames,
                                          ...peopleOptions.map((u) => [u.id, u.label] as const),
                                        ])}
                                        groups={Object.fromEntries(
                                          groups.ok ? groups.data.map((g) => [g.key, g.name]) : [],
                                        )}
                                      />
                                    </div>
                                  </details>
                                </Th>
                                <Td>
                                  <Badge tone={STATUS[v.status].tone}>
                                    {STATUS[v.status].label}
                                  </Badge>
                                  {v.status !== 'draft' ? (
                                    <span className={`${styles.hint} ${styles.readOnly}`}>
                                      Read-only
                                    </span>
                                  ) : null}
                                </Td>
                                <Td>
                                  {v.publishedAt ? (
                                    <time dateTime={v.publishedAt}>
                                      {formatInstant(v.publishedAt)}
                                    </time>
                                  ) : (
                                    <span className={styles.muted}>Not published</span>
                                  )}
                                </Td>
                                <Td>
                                  {v.status === 'draft' &&
                                  canPublish &&
                                  v.savedByCaller &&
                                  v.publishSoleEligible ? (
                                    <SoleEligiblePublishForm
                                      action={publishVersionAction}
                                      fields={{ key: wf.key, version: String(v.version) }}
                                      hiddenLabel={`version ${v.version} of ${wf.name}`}
                                    />
                                  ) : v.status === 'draft' && draftPublishBlock(v, canPublish) ? (
                                    <span className={styles.hint}>
                                      {draftPublishBlock(v, canPublish)}
                                    </span>
                                  ) : v.status === 'draft' ? (
                                    <ActionButton
                                      action={publishVersionAction}
                                      fields={{ key: wf.key, version: String(v.version) }}
                                      label="Publish"
                                      hiddenLabel={`version ${v.version} of ${wf.name}`}
                                      variant="primary"
                                      confirmText="New requests will use this version, and the version in use will be retired."
                                    />
                                  ) : (
                                    <span className={styles.muted}>
                                      <span aria-hidden="true">-</span>
                                      <span className="sr-only">No action available</span>
                                    </span>
                                  )}
                                </Td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>

                        {canEdit ? (
                          <details className={styles.disclosure}>
                            <summary>
                              <Icon name="chevron-right" size={16} className={styles.chevron} />
                              <span>
                                Edit as a new draft
                                <span className="sr-only"> of {wf.name}</span>
                              </span>
                            </summary>
                            <div className={styles.disclosureBody}>
                              <p className={styles.hint}>
                                Starts from version {latest?.version ?? '-'}. Saving adds version{' '}
                                {(latest?.version ?? 0) + 1} as a draft; it changes nothing until
                                you publish it.
                              </p>
                              <WorkflowEditor
                                action={saveDraftAction}
                                mode="version"
                                workflowKey={wf.key}
                                documentType={wf.documentType}
                                initialSpec={latest?.spec}
                                submitLabel={`Save as draft version ${(latest?.version ?? 0) + 1}`}
                                groupKeys={groupKeys}
                                users={userOptions}
                              />
                            </div>
                          </details>
                        ) : null}
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}

            {canEdit ? (
              <details className={styles.disclosure}>
                <summary>
                  <Icon name="chevron-right" size={16} className={styles.chevron} />
                  <span>New workflow</span>
                </summary>
                <div className={styles.disclosureBody}>
                  <WorkflowEditor
                    // Remounts when the saved defaults change, so the form never starts from stale times.
                    key={JSON.stringify(slaDefaults)}
                    action={createWorkflowAction}
                    mode="create"
                    documentType=""
                    initialSpec={undefined}
                    submitLabel="Create as draft"
                    groupKeys={groupKeys}
                    users={userOptions}
                    slaDefaults={slaDefaults}
                  />
                </div>
              </details>
            ) : null}
          </>
        )}
      </section>

      {/* ---- approval groups ----------------------------------------------------------------- */}
      {canGroups ? (
        <section className={styles.section} id="groups" aria-labelledby="grp-heading">
          <SectionHead id="grp-heading" title="Approval groups">
            A group is a named set of people. A workflow step can name a group, and any member can
            act on it.
          </SectionHead>
          {!groups.ok ? (
            <SectionError message={groups.message} />
          ) : (
            <>
              {groups.data.length === 0 ? (
                <EmptyState title="No approval groups yet." headingLevel={3} />
              ) : (
                <ul className={styles.groupList}>
                  {groups.data.map((g) => (
                    <li key={g.id}>
                      <Panel
                        title={g.name}
                        headingLevel={3}
                        description={<span className={styles.groupKey}>{g.key}</span>}
                        actions={
                          <ActionButton
                            action={deleteGroupAction}
                            fields={{ id: g.id }}
                            label="Delete group"
                            hiddenLabel={g.name}
                            variant="dangerOutline"
                            confirmText="The group and its memberships will be removed."
                          />
                        }
                      >
                        {g.memberUserIds.length === 0 ? (
                          <p className={styles.muted}>No members yet.</p>
                        ) : (
                          <ul className={styles.members}>
                            {g.memberUserIds.map((userId) => (
                              <li key={userId} className={styles.member}>
                                <Person {...personOf(userId)} />
                                <ActionButton
                                  action={removeMemberAction}
                                  fields={{ groupId: g.id, userId }}
                                  label="Remove"
                                  hiddenLabel={`${labelOf(userId)} from ${g.name}`}
                                  variant="danger"
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className={styles.addMember}>
                          <AddMemberForm groupId={g.id} groupName={g.name} users={groupOptions} />
                        </div>
                      </Panel>
                    </li>
                  ))}
                </ul>
              )}
              <Panel title="New group" headingLevel={3}>
                <CreateGroupForm />
              </Panel>
            </>
          )}
        </section>
      ) : null}

      {/* ---- delegations --------------------------------------------------------------------- */}
      {canDelegations ? (
        <section className={styles.section} id="delegations" aria-labelledby="del-heading">
          <SectionHead id="del-heading" title="Delegations">
            Lets one person act for another for a period, for example during leave. Revoking keeps
            the record in the audit trail; it just stops counting.
          </SectionHead>
          {!delegations.ok ? (
            <SectionError message={delegations.message} />
          ) : (
            <>
              {!delegationPeople.ok ? (
                <Notice>
                  People could not be loaded ({delegationPeople.message}). Existing assignments are
                  retained. Reload or ask an administrator for access before choosing a person.
                </Notice>
              ) : null}
              {delegations.data.length === 0 ? (
                <EmptyState title="No active delegations." headingLevel={3} />
              ) : (
                <Table
                  caption="Active delegations"
                  className={adminStyles.local ?? ''}
                  minWidth={760}
                >
                  <thead>
                    <tr>
                      <Th>From</Th>
                      <Th>To</Th>
                      <Th>Window (Nepal time)</Th>
                      <Th>Applies to</Th>
                      <Th>Action</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {delegations.data.map((d) => (
                      <tr key={d.id}>
                        <Th scope="row" className={adminStyles.rowHead}>
                          <Person {...personOf(d.fromUserId)} />
                        </Th>
                        <Td>
                          <Person {...personOf(d.toUserId)} />
                        </Td>
                        <Td>
                          <time className={styles.nowrap} dateTime={d.startsAt}>
                            {formatInstant(d.startsAt)}
                          </time>{' '}
                          to{' '}
                          <time className={styles.nowrap} dateTime={d.endsAt}>
                            {formatInstant(d.endsAt)}
                          </time>
                        </Td>
                        <Td>
                          {d.documentType ?? <span className={styles.muted}>All documents</span>}
                        </Td>
                        <Td>
                          <ActionButton
                            action={revokeDelegationAction}
                            fields={{ id: d.id }}
                            label="Revoke"
                            hiddenLabel={`delegation from ${labelOf(d.fromUserId)} to ${labelOf(d.toUserId)}`}
                            variant="dangerOutline"
                            confirmText="The person taking over will no longer be able to act for the other."
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <Panel title="New delegation" headingLevel={3}>
                <DelegationForm users={delegationOptions} documentTypes={documentTypes} />
              </Panel>
            </>
          )}
        </section>
      ) : null}
    </Page>
  );
}

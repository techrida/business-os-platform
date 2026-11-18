import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import {
  listApprovalGroups,
  listDelegations,
  listUsers,
  listWorkflows,
  type WorkflowVersion,
} from '@/lib/api-admin';

import adminStyles from '../admin.module.css';
import { formatInstant } from '../format';
import { requireSession } from '../guard';
import { section } from '../section';
import { Notice, SectionError } from '../ui';
import {
  createWorkflowAction,
  deleteGroupAction,
  publishVersionAction,
  removeMemberAction,
  revokeDelegationAction,
  saveDraftAction,
} from './actions';
import { AddMemberForm, ActionButton, CreateGroupForm, DelegationForm } from './panels';
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

/** An initials avatar, the name, and the email under it. The avatar is decoration. */
function Person({
  name,
  email,
  unknown = false,
}: {
  name: string;
  email: string | null;
  unknown?: boolean;
}) {
  return (
    <div className={styles.person}>
      <Avatar name={unknown ? '' : name} shape="circle" />
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

export default async function WorkflowsPage() {
  const session = await requireSession('/admin/workflows');

  // Four independent reads. Each can fail alone (each route needs its own permission), and the
  // user list only feeds the pickers and the name lookups, so its failure is never fatal.
  const [workflows, groups, delegations, users] = await Promise.all([
    section('view workflows', () => listWorkflows(session)),
    section('manage approval groups', () => listApprovalGroups(session)),
    section('manage delegations', () => listDelegations(session)),
    section('view users', () => listUsers(session, { limit: 200 })),
  ]);

  const userOptions: UserOption[] | null = users.ok
    ? users.data.items
        .filter((u) => u.status !== 'inactive')
        .map((u) => ({
          id: u.id,
          label:
            u.displayName && u.email
              ? `${u.displayName} (${u.email})`
              : (u.displayName ?? u.email ?? 'Name unavailable'),
          name: u.displayName ?? u.email ?? 'Name unavailable',
          email: u.displayName ? u.email : null,
        }))
    : null;
  const optionOf = (id: string): UserOption | undefined => userOptions?.find((u) => u.id === id);
  const labelOf = (id: string): string => optionOf(id)?.label ?? 'Name unavailable';
  const personOf = (id: string) => {
    const option = optionOf(id);
    return option
      ? { name: option.name, email: option.email, unknown: false }
      : { name: 'Name unavailable', email: null, unknown: true };
  };

  const groupKeys = groups.ok ? groups.data.map((g) => g.key) : [];
  const documentTypes = workflows.ok ? [...new Set(workflows.data.map((w) => w.documentType))] : [];

  return (
    <Page className={adminStyles.page}>
      <Breadcrumb items={[{ label: 'Administration', href: '/admin' }, { label: 'Workflows' }]} />
      <PageHeader
        title="Workflows"
        description="Manage approval routes, groups and delegations. Submitted requests keep the workflow version they started with."
      />

      <nav aria-label="On this page" className={styles.jump}>
        <a href="#workflows">Workflows</a>
        <a href="#groups">Approval groups</a>
        <a href="#delegations">Delegations</a>
      </nav>

      {/* ---- workflows ------------------------------------------------------------------------- */}
      <section className={styles.section} id="workflows" aria-labelledby="wf-heading">
        <SectionHead id="wf-heading" title="Workflow definitions" />

        {!workflows.ok ? (
          <SectionError message={workflows.message} />
        ) : (
          <>
            {workflows.data.length === 0 ? (
              <EmptyState title="No workflows yet." headingLevel={3}>
                Create the first one below.
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
                                  <details className={styles.specToggle}>
                                    <summary>
                                      View spec
                                      <span className="sr-only"> of version {v.version}</span>
                                    </summary>
                                    <div className={styles.specBody}>
                                      <SpecSummary spec={v.spec} />
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
                                  {v.status === 'draft' ? (
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
                              {(latest?.version ?? 0) + 1} as a draft; it changes nothing until you
                              publish it.
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
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}

            <details className={styles.disclosure}>
              <summary>
                <Icon name="chevron-right" size={16} className={styles.chevron} />
                <span>New workflow</span>
              </summary>
              <div className={styles.disclosureBody}>
                <WorkflowEditor
                  action={createWorkflowAction}
                  mode="create"
                  documentType=""
                  initialSpec={undefined}
                  submitLabel="Create as draft"
                  groupKeys={groupKeys}
                  users={userOptions}
                />
              </div>
            </details>
          </>
        )}
      </section>

      {/* ---- approval groups ----------------------------------------------------------------- */}
      <section className={styles.section} id="groups" aria-labelledby="grp-heading">
        <SectionHead id="grp-heading" title="Approval groups">
          A group is a named set of people. A workflow step can name a group, and any member can act
          on it.
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
                        <AddMemberForm groupId={g.id} groupName={g.name} users={userOptions} />
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

      {/* ---- delegations --------------------------------------------------------------------- */}
      <section className={styles.section} id="delegations" aria-labelledby="del-heading">
        <SectionHead id="del-heading" title="Delegations">
          Lets one person act for another for a period, for example during leave. Revoking keeps the
          record in the audit trail; it just stops counting.
        </SectionHead>
        {!delegations.ok ? (
          <SectionError message={delegations.message} />
        ) : (
          <>
            {!users.ok ? (
              <Notice>
                The list of people is not available ({users.message}), so you will see short ids and
                need to type one in.
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
              <DelegationForm users={userOptions} documentTypes={documentTypes} />
            </Panel>
          </>
        )}
      </section>
    </Page>
  );
}

import {
  listApprovalGroups,
  listDelegations,
  listUsers,
  listWorkflows,
  type WorkflowVersion,
} from '@/lib/api-admin';

import styles from '../admin.module.css';
import { formatInstant } from '../format';
import { requireSession } from '../guard';
import { section } from '../section';
import { Notice, PageHead, SectionError } from '../ui';
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

const STATUS_CLASS: Record<WorkflowVersion['status'], string> = {
  published: styles.chipOk ?? '',
  draft: styles.chipWarn ?? '',
  retired: styles.chipNeutral ?? '',
};

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
              : (u.displayName ?? u.email ?? `User ${u.id.slice(0, 8)}`),
        }))
    : null;
  const labelOf = (id: string): string =>
    userOptions?.find((u) => u.id === id)?.label ?? `User ${id.slice(0, 8)}`;

  const groupKeys = groups.ok ? groups.data.map((g) => g.key) : [];
  const documentTypes = workflows.ok ? [...new Set(workflows.data.map((w) => w.documentType))] : [];

  return (
    <>
      <PageHead title="Workflows">
        Who approves what. A published version is frozen: to change a route, save a new draft and
        publish it. Requests already submitted keep the version they started with.
      </PageHead>

      <nav aria-label="On this page" className={styles.actions}>
        <a className={styles.link} href="#workflows">
          Workflows
        </a>
        <a className={styles.link} href="#groups">
          Approval groups
        </a>
        <a className={styles.link} href="#delegations">
          Delegations
        </a>
      </nav>

      {/* ---- workflows ------------------------------------------------------------------------- */}
      <section className={styles.section} id="workflows" aria-labelledby="wf-heading">
        <div className={styles.sectionHead}>
          <h2 id="wf-heading">Workflow definitions</h2>
        </div>

        {!workflows.ok ? (
          <SectionError message={workflows.message} />
        ) : (
          <>
            {workflows.data.length === 0 ? (
              <p className={styles.empty}>No workflows yet. Create the first one below.</p>
            ) : null}

            {workflows.data.map((wf) => {
              const latest = wf.versions.at(-1);
              const current = wf.versions.find((v) => v.id === wf.currentVersionId);
              const versionsDesc = [...wf.versions].reverse();
              return (
                <article key={wf.id} className={styles.workflow} aria-labelledby={`wf-${wf.id}`}>
                  <div className={styles.workflowHead}>
                    <h3 id={`wf-${wf.id}`}>{wf.name}</h3>
                    <span className={styles.muted}>
                      <span className={styles.mono}>{wf.key}</span> for{' '}
                      <span className={styles.mono}>{wf.documentType}</span>
                    </span>
                  </div>
                  <p className={styles.hint} style={{ margin: '0.25rem 0 0.75rem' }}>
                    {current
                      ? `In use: version ${current.version}.`
                      : 'Not in use yet: publish a draft to start using this workflow.'}
                  </p>

                  <div
                    className={styles.tableWrap}
                    role="region"
                    aria-labelledby={`vt-${wf.id}`}
                    tabIndex={0}
                  >
                    <table className={styles.table}>
                      <caption id={`vt-${wf.id}`} className={styles.srOnly}>
                        Versions of {wf.name}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Version</th>
                          <th scope="col">Status</th>
                          <th scope="col">Published</th>
                          <th scope="col">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {versionsDesc.map((v) => (
                          <tr key={v.id}>
                            <th scope="row">
                              Version {v.version}
                              <details className={styles.inlineDetails}>
                                <summary>
                                  View spec
                                  <span className={styles.srOnly}> of version {v.version}</span>
                                </summary>
                                <SpecSummary spec={v.spec} />
                              </details>
                            </th>
                            <td>
                              <span className={`${styles.chip} ${STATUS_CLASS[v.status]}`}>
                                {v.status}
                              </span>
                              {v.status !== 'draft' ? (
                                <span className={`${styles.hint} ${styles.cellWrap}`}>
                                  Read-only
                                </span>
                              ) : null}
                            </td>
                            <td>
                              {v.publishedAt ? (
                                formatInstant(v.publishedAt)
                              ) : (
                                <span className={styles.muted}>Not published</span>
                              )}
                            </td>
                            <td>
                              {v.status === 'draft' ? (
                                <ActionButton
                                  action={publishVersionAction}
                                  fields={{ key: wf.key, version: String(v.version) }}
                                  label="Publish"
                                  hiddenLabel={`version ${v.version} of ${wf.name}`}
                                  variant="primary"
                                  confirmText={`Publish version ${v.version} of "${wf.name}"? New requests will use it, and the version in use is retired.`}
                                />
                              ) : (
                                <span className={styles.muted}>-</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <details className={styles.details} style={{ marginTop: '0.75rem' }}>
                    <summary>
                      Edit as a new draft
                      <span className={styles.srOnly}> of {wf.name}</span>
                    </summary>
                    <div className={styles.detailsBody}>
                      <p className={styles.hint} style={{ marginBottom: '0.75rem' }}>
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
              );
            })}

            <details className={styles.details} style={{ marginTop: '1rem' }}>
              <summary>New workflow</summary>
              <div className={styles.detailsBody}>
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
        <div className={styles.sectionHead}>
          <h2 id="grp-heading">Approval groups</h2>
          <p>
            A group is a named set of people. A workflow step can name a group, and any member can
            act on it.
          </p>
        </div>
        {!groups.ok ? (
          <SectionError message={groups.message} />
        ) : (
          <>
            {groups.data.length === 0 ? (
              <p className={styles.empty}>No approval groups yet.</p>
            ) : (
              <div className={styles.stack}>
                {groups.data.map((g) => (
                  <article
                    key={g.id}
                    className={styles.workflow}
                    style={{ margin: 0 }}
                    aria-labelledby={`g-${g.id}`}
                  >
                    <div className={styles.workflowHead}>
                      <h3 id={`g-${g.id}`}>{g.name}</h3>
                      <span className={`${styles.mono} ${styles.muted}`}>{g.key}</span>
                    </div>
                    {g.memberUserIds.length === 0 ? (
                      <p className={styles.hint} style={{ margin: '0.5rem 0' }}>
                        No members yet.
                      </p>
                    ) : (
                      <ul
                        className={styles.stack}
                        style={{ margin: '0.5rem 0', padding: 0, listStyle: 'none' }}
                      >
                        {g.memberUserIds.map((userId) => (
                          <li key={userId} className={styles.actions}>
                            <span className={styles.cellWrap}>{labelOf(userId)}</span>
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
                    <AddMemberForm groupId={g.id} groupName={g.name} users={userOptions} />
                    <div style={{ marginTop: '0.75rem' }}>
                      <ActionButton
                        action={deleteGroupAction}
                        fields={{ id: g.id }}
                        label="Delete group"
                        hiddenLabel={g.name}
                        variant="danger"
                        confirmText={`Delete the group "${g.name}"?`}
                      />
                    </div>
                  </article>
                ))}
              </div>
            )}
            <h3 className={styles.sub}>New group</h3>
            <CreateGroupForm />
          </>
        )}
      </section>

      {/* ---- delegations --------------------------------------------------------------------- */}
      <section className={styles.section} id="delegations" aria-labelledby="del-heading">
        <div className={styles.sectionHead}>
          <h2 id="del-heading">Delegations</h2>
          <p>
            Lets one person act for another for a period, for example during leave. Revoking keeps
            the record in the audit trail; it just stops counting.
          </p>
        </div>
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
              <p className={styles.empty}>No active delegations.</p>
            ) : (
              <div
                className={styles.tableWrap}
                role="region"
                aria-labelledby="del-caption"
                tabIndex={0}
              >
                <table className={styles.table}>
                  <caption id="del-caption" className={styles.srOnly}>
                    Active delegations
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">From</th>
                      <th scope="col">To</th>
                      <th scope="col">Window (Nepal time)</th>
                      <th scope="col">Applies to</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {delegations.data.map((d) => (
                      <tr key={d.id}>
                        <th scope="row" className={styles.cellWrap}>
                          {labelOf(d.fromUserId)}
                        </th>
                        <td className={styles.cellWrap}>{labelOf(d.toUserId)}</td>
                        <td>
                          {formatInstant(d.startsAt)} to {formatInstant(d.endsAt)}
                        </td>
                        <td>
                          {d.documentType ?? <span className={styles.muted}>All documents</span>}
                        </td>
                        <td>
                          <ActionButton
                            action={revokeDelegationAction}
                            fields={{ id: d.id }}
                            label="Revoke"
                            hiddenLabel={`delegation from ${labelOf(d.fromUserId)} to ${labelOf(d.toUserId)}`}
                            variant="danger"
                            confirmText="Revoke this delegation? The person taking over can no longer act for the other."
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3 className={styles.sub}>New delegation</h3>
            <DelegationForm users={userOptions} documentTypes={documentTypes} />
          </>
        )}
      </section>
    </>
  );
}

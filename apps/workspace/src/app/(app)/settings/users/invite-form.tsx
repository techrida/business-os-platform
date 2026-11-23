'use client';

import { useActionState } from 'react';

import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';

import { IDLE } from '../action-state';
import { FormStatus } from '../ui';
import { inviteUserAction } from './actions';
import { RoleCheckboxes } from './role-checkboxes';
import styles from './users.module.css';

/** The Figma section title: a small grey step label over the title. The label is decoration. */
function SectionTitle({ step, children }: { step: string; children: string }) {
  return (
    <>
      <span aria-hidden="true" className={styles.eyebrow}>
        {step}
      </span>
      {children}
    </>
  );
}

const LEVELS = [
  { value: 'staff', label: 'Staff' },
  { value: 'manager', label: 'Manager' },
  { value: 'head', label: 'Head of department' },
] as const;

// A Client Component for useActionState only: it shows the result without a page reload. The write
// itself is the Server Action. The form wraps the page header so its Save button submits the form
// and is disabled while the request runs.
// `departments` is null when the person may not place people (no `admin.roles.write`): the fields are left out.
export function InviteForm({
  departments = null,
}: {
  departments?: readonly { id: string; name: string }[] | null;
}) {
  const [state, formAction, pending] = useActionState(inviteUserAction, IDLE);
  const fields = state.fields ?? {};
  // On success the form clears (React resets it); on an error `fields` puts the values back.
  const kept = state.status === 'error' ? fields : {};

  return (
    <form noValidate action={formAction} className={styles.form}>
      <PageHeader
        title="Add New User"
        description="Add a colleague and choose the roles they hold."
        actions={
          <>
            <LinkButton href="/settings/users" variant="secondary">
              {state.status === 'ok' ? 'Back to users' : 'Cancel'}
            </LinkButton>
            <Button type="submit" disabled={pending}>
              Send invitation
            </Button>
          </>
        }
      />

      <FormStatus state={state} pending={pending} />

      <Panel
        className={styles.sectionPanel ?? ''}
        title={<SectionTitle step="01 · The basics">User Profile & Identity</SectionTitle>}
      >
        <div className={styles.fieldGrid}>
          <Field label="First name" error={state.fieldErrors?.givenName}>
            {(control) => (
              <Input
                name="givenName"
                maxLength={200}
                placeholder="First name"
                autoComplete="off"
                required
                defaultValue={kept.givenName ?? ''}
                {...control}
              />
            )}
          </Field>
          <Field label="Last name" error={state.fieldErrors?.familyName}>
            {(control) => (
              <Input
                name="familyName"
                maxLength={200}
                placeholder="Last name"
                autoComplete="off"
                required
                defaultValue={kept.familyName ?? ''}
                {...control}
              />
            )}
          </Field>
          <Field label="Work email" error={state.fieldErrors?.email}>
            {(control) => (
              <Input
                type="email"
                name="email"
                maxLength={320}
                placeholder="name@company.com"
                autoComplete="off"
                required
                defaultValue={kept.email ?? ''}
                {...control}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        className={styles.sectionPanel ?? ''}
        title={<SectionTitle step="02 · Roles">Role & Access Configuration</SectionTitle>}
        description="Select the roles this person holds. You can change these later."
      >
        {departments !== null && (
          <div className={styles.fieldGrid}>
            <Field
              label="Department"
              optional
              hint="Access to department records follows it."
              error={state.fieldErrors?.departmentId}
            >
              {(control) => (
                <Select
                  name="departmentId"
                  defaultValue={kept.departmentId ?? ''}
                  options={[
                    { value: '', label: 'No department' },
                    ...departments.map((d) => ({ value: d.id, label: d.name })),
                  ]}
                  {...control}
                />
              )}
            </Field>
            <Field label="Level" optional>
              {(control) => (
                <Select
                  name="level"
                  defaultValue={kept.level || 'staff'}
                  options={LEVELS}
                  {...control}
                />
              )}
            </Field>
          </div>
        )}
        <RoleCheckboxes
          idPrefix="invite-role"
          legend="Roles"
          hideLegend
          checked={(kept.roles ?? '').split(',').filter(Boolean)}
        />
      </Panel>
      <Panel
        className={styles.sectionPanel ?? ''}
        title={<SectionTitle step="03 · Onboarding">Onboarding &amp; Credentials</SectionTitle>}
      >
        <div className={styles.activation}>
          <Icon name="inbox" size={20} />
          <div>
            <h3>Email invitation</h3>
            <p>Your colleague receives an email to set up their sign-in.</p>
          </div>
        </div>
      </Panel>
    </form>
  );
}

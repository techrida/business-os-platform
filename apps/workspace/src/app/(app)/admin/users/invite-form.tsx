'use client';

import { useActionState } from 'react';

import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
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

// A Client Component for useActionState only: it shows the result without a page reload. The write
// itself is the Server Action. The form wraps the page header so its Save button submits the form
// and is disabled while the request runs.
export function InviteForm() {
  const [state, formAction, pending] = useActionState(inviteUserAction, IDLE);
  const fields = state.fields ?? {};
  // On success the form clears (React resets it); on an error `fields` puts the values back.
  const kept = state.status === 'error' ? fields : {};

  return (
    <form action={formAction} className={styles.form}>
      <PageHeader
        title="Invite user"
        description="Add a colleague and choose the roles they hold. They get an email to set up their sign-in."
        actions={
          <>
            <LinkButton href="/admin/users" variant="secondary">
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
        title={<SectionTitle step="01 · The basics">User profile & identity</SectionTitle>}
      >
        <div className={styles.fieldGrid}>
          <Field label="Given name">
            {(control) => (
              <Input
                name="givenName"
                autoComplete="off"
                required
                defaultValue={kept.givenName ?? ''}
                {...control}
              />
            )}
          </Field>
          <Field label="Family name">
            {(control) => (
              <Input
                name="familyName"
                autoComplete="off"
                required
                defaultValue={kept.familyName ?? ''}
                {...control}
              />
            )}
          </Field>
          <Field label="Email" className={styles.wide ?? ''}>
            {(control) => (
              <Input
                type="email"
                name="email"
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
        title={<SectionTitle step="02 · Roles">Role & access configuration</SectionTitle>}
        description="Tick every role this person holds. Roles can be changed later."
      >
        <RoleCheckboxes
          idPrefix="invite-role"
          legend="Roles"
          hideLegend
          checked={(kept.roles ?? '').split(',').filter(Boolean)}
        />
      </Panel>
    </form>
  );
}

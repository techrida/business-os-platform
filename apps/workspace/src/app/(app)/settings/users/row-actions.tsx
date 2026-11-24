import type { AdminUser } from '@bos/contracts';
import type { ReactNode } from 'react';

import { Button, LinkButton } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Tooltip } from '@/components/ui/tooltip';

import { PasswordReset } from './password-reset';
import { PictureEditor } from './picture-editor';
import { RolesEditor } from './roles-editor';
import { StatusAction } from './status-actions';
import styles from './users.module.css';

/** The fixed slots of a directory row, left to right. Every row renders all of them, so the columns line up. */
export type SlotId = 'picture' | 'roles' | 'access' | 'reset' | 'lock' | 'toggle';

export const ROW_SLOTS: readonly SlotId[] = [
  'picture',
  'roles',
  'access',
  'reset',
  'lock',
  'toggle',
];

/** What the caller may do on this page, the same for every row. */
export interface RowCapabilities {
  /** `admin.roles.read`: Settings > Access opens. */
  canCheckAccess: boolean;
  /** The summary's `canSendPasswordReset`. */
  canSendPasswordReset: boolean;
  /** The summary's company-wide `canChangeStatus`, and the caller's own id is known. */
  canChangeStatus: boolean;
  /** The caller's own user id, whose row takes no status action. */
  meId: string | null;
}

export const OWN_ACCOUNT = 'You can’t change your own access';

function Slot({ id, children }: { id: SlotId; children?: ReactNode }) {
  return (
    <span className={styles.slot} data-slot={id}>
      {children}
    </span>
  );
}

/**
 * An action that does not apply to this row, shown but off, with the reason in the design-system tooltip (hover and
 * keyboard focus; the bubble is linked to the button with `aria-describedby`). The button stays in the tab order with
 * `aria-disabled` (a natively disabled button takes no focus and no hover, so the reason would never show) and has no
 * handler, so a click does nothing.
 */
export function Muted({
  id,
  name,
  reason,
  children,
}: {
  id: SlotId;
  name: string;
  reason: string;
  children: ReactNode;
}) {
  return (
    <Slot id={id}>
      <Tooltip content={reason} align="end">
        <Button
          variant="ghost"
          size="small"
          aria-disabled="true"
          aria-label={`${name} (unavailable)`}
        >
          {children}
        </Button>
      </Tooltip>
    </Slot>
  );
}

/**
 * The row's actions, every one in its own fixed slot. An action that cannot run on this row's state is shown muted
 * with the reason. An action the caller's role never has stays out of sight but keeps its (empty) slot, so a role
 * with fewer permissions sees the same column layout and the page does not reveal what it cannot do.
 */
export function RowActions({
  user,
  name,
  label,
  can,
}: {
  user: AdminUser;
  name: string;
  label: string;
  can: RowCapabilities;
}) {
  const picture = user.avatarDocumentId ?? null;
  const own = user.id === can.meId;
  const locked = user.lockReason ?? null;

  const reset = (() => {
    if (!can.canSendPasswordReset) return <Slot id="reset" />;
    const name = `Send password reset email to ${label}`;
    const reason = !user.email
      ? 'No email address set for this user'
      : user.status === 'invited'
        ? 'This user hasn’t accepted their invitation yet'
        : user.status === 'inactive'
          ? 'Can’t send a password reset to a deactivated user'
          : null;
    if (reason === null && user.email) {
      return (
        <Slot id="reset">
          <PasswordReset userId={user.id} label={label} email={user.email} />
        </Slot>
      );
    }
    return (
      <Muted id="reset" name={name} reason={reason ?? 'No email address set for this user'}>
        <Icon name="mail" size={20} />
      </Muted>
    );
  })();

  const status = (() => {
    if (!can.canChangeStatus) {
      return [<Slot key="lock" id="lock" />, <Slot key="toggle" id="toggle" />];
    }
    const live = (
      id: SlotId,
      action: Parameters<typeof StatusAction>[0]['action'],
      canKeepLocked = false,
    ) => (
      <Slot key={id} id={id}>
        <StatusAction
          userId={user.id}
          name={name}
          label={label}
          action={action}
          canKeepLocked={canKeepLocked}
        />
      </Slot>
    );
    const off = (id: SlotId, text: string, reason: string) => (
      <Muted key={id} id={id} name={`${text} ${label}`} reason={reason}>
        {text}
      </Muted>
    );
    if (own) {
      return [
        off('lock', 'Lock', OWN_ACCOUNT),
        off('toggle', user.status === 'inactive' ? 'Reactivate' : 'Deactivate', OWN_ACCOUNT),
      ];
    }
    const lock = locked
      ? live('lock', 'unlock', locked === 'failed_sign_ins')
      : user.status === 'active'
        ? live('lock', 'lock')
        : off(
            'lock',
            'Lock',
            user.status === 'inactive'
              ? 'Can’t lock a deactivated user'
              : 'Can’t lock a user who hasn’t accepted their invitation yet',
          );
    const toggle =
      locked || user.status === 'active'
        ? live('toggle', 'deactivate')
        : user.status === 'inactive'
          ? live('toggle', 'reactivate')
          : off(
              'toggle',
              'Deactivate',
              'Can’t deactivate a user who hasn’t accepted their invitation yet',
            );
    return [lock, toggle];
  })();

  return (
    <div className={styles.rowActions}>
      <Slot id="picture">
        <PictureEditor userId={user.id} name={name} label={label} imageDocumentId={picture} />
      </Slot>
      <Slot id="roles">
        <RolesEditor userId={user.id} label={label} roles={user.roles} />
      </Slot>
      {can.canCheckAccess ? (
        <Slot id="access">
          <LinkButton
            href={`/settings/access/check?person=${encodeURIComponent(user.id)}`}
            variant="ghost"
            size="small"
            aria-label={`Check access for ${label}`}
          >
            Check access
          </LinkButton>
        </Slot>
      ) : (
        <Slot id="access" />
      )}
      {reset}
      {status}
    </div>
  );
}

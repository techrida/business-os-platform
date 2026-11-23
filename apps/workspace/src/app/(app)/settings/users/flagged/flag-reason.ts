/** Plain words for the audit reason of a flag (`users.<action>:<cause>`), shown on Settings > Users > Flagged. */
const ACTIONS: Record<string, string> = {
  deactivate: 'Deactivating this person',
  reactivate: 'Reactivating this person',
  lock: 'Locking this person',
  unlock: 'Unlocking this person',
  set_roles: 'Changing this person’s roles',
  invite: 'Inviting this person',
};

const CAUSES: Record<string, string> = {
  phase_b_failed:
    'failed or timed out in the identity provider, so BOS cannot tell what it now holds',
  phase_c_failed: 'reached the identity provider, but BOS could not save the result',
  failed: 'failed before the identity provider confirmed it',
  lease_taken_over:
    'was left unfinished by an earlier request, so the identity provider may already have changed it',
};

export function describeFlagReason(reason: string | null): string {
  if (reason === null) return 'The reason was not recorded.';
  const match = /^users\.([a-z_]+):([a-z_]+)$/.exec(reason);
  const action = match?.[1] === undefined ? undefined : ACTIONS[match[1]];
  const cause = match?.[2] === undefined ? undefined : CAUSES[match[2]];
  return action && cause ? `${action} ${cause}.` : `Flagged by ${reason}.`;
}

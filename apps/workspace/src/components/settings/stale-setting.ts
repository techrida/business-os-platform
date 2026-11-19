// A settings save that lost a race: someone else saved a newer version after this screen loaded.
// The API answers 409 with the code `stale_setting` when the request carried `expectedVersion`.
import { ErrorBodySchema } from '@bos/contracts';

/** The sentence a card shows at its foot; it keeps the person's unsaved choice and offers a reload. */
export const STALE_SETTING_MESSAGE = 'This was changed by someone else. Reload to see the latest.';

/** True for the API's 409 `stale_setting`. Duck-typed on `status` and `body`, like describeError. */
export function isStaleSettingError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (!('status' in error) || error.status !== 409) return false;
  if (!('body' in error)) return false;
  const parsed = ErrorBodySchema.safeParse(error.body);
  return parsed.success && parsed.data.error.code === 'stale_setting';
}

/** The version to send back: the loaded one, or null when the screen loaded the default. */
export function loadedVersion(version: number | null | undefined): number | null {
  return typeof version === 'number' ? version : null;
}

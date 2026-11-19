'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import type { ActionState } from '@/app/(app)/settings/action-state';
import { FormStatus } from '@/app/(app)/settings/form-status';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { STALE_SETTING_MESSAGE } from './stale-setting';

/**
 * True for the action's answer to a save or reset that lost a race (see `stale-setting.ts`): the
 * plain stale message, or any error the action flagged `stale` because it words the race itself.
 */
export const isStaleState = (state: ActionState): boolean =>
  state.status === 'error' && (state.stale === true || state.message === STALE_SETTING_MESSAGE);

/**
 * Remembers which loaded version a stale answer belonged to, and what it said. Once the page
 * reloads with a newer version the notice goes away by itself, and the person's unsaved choice is
 * still there to save. A card that writes several settings passes one string for all their versions.
 */
export function useStaleVersion(version: number | string | null): {
  stale: boolean;
  /** The stale answer's own message (the plain stale sentence unless the action worded it). */
  staleMessage: string;
  markStale: (loaded: number | string | null, message?: string) => void;
  clearStale: () => void;
} {
  const [at, setAt] = useState<{ version: number | string | null; message: string } | null>(null);
  return {
    stale: at !== null && at.version === version,
    staleMessage: at?.message ?? STALE_SETTING_MESSAGE,
    markStale: (loaded, message = STALE_SETTING_MESSAGE) => setAt({ version: loaded, message }),
    clearStale: () => setAt(null),
  };
}

/**
 * "Changed by someone else" at the card foot, with a Reload button. Reloading refreshes the page's
 * data in place; the card keeps what the person chose over the new saved values.
 */
export function StaleNotice({ message = STALE_SETTING_MESSAGE }: { message?: string }) {
  const router = useRouter();
  const [reloading, startReload] = useTransition();
  return (
    <Alert
      tone="warning"
      role="alert"
      actions={
        <Button
          variant="secondary"
          size="small"
          disabled={reloading}
          onClick={() => startReload(() => router.refresh())}
        >
          {reloading ? 'Reloading…' : 'Reload'}
        </Button>
      }
    >
      {message}
    </Alert>
  );
}

/**
 * The end of a format card: the stale notice when there is one, then the status and Save. Save is on
 * only while something differs from what is saved. A stale answer is shown by the notice, not twice.
 */
export function FormatCardFoot({
  state,
  pending,
  dirty,
  stale,
}: {
  state: ActionState;
  pending: boolean;
  dirty: boolean;
  stale: boolean;
}) {
  return (
    <>
      {stale ? <StaleNotice /> : null}
      <div className={shell.foot}>
        <div className={shell.status}>
          <FormStatus state={state} pending={pending} inline={!isStaleState(state)} />
        </div>
        <Button type="submit" disabled={!dirty || pending}>
          Save
        </Button>
      </div>
    </>
  );
}

'use client';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Icon, type IconName } from '@/components/ui/icon';

import type { DraftConflict, SyncStatus } from './draft-sync';
import styles from './memo-template.module.css';

interface Look {
  label: string;
  icon?: IconName;
  tone?: 'good' | 'bad';
  /** Routine progress is not announced to a screen reader on every pause between keystrokes. */
  announce: boolean;
}

const LOOKS: Record<SyncStatus, Look | null> = {
  loading: null,
  idle: null,
  frozen: null,
  dirty: { label: 'Saving', announce: false },
  saving: { label: 'Saving', announce: false },
  saved: { label: 'Saved', icon: 'check-circle', tone: 'good', announce: true },
  offline: { label: 'Offline', icon: 'alert-triangle', tone: 'bad', announce: true },
  blocked: { label: 'Not saved', icon: 'x-circle', tone: 'bad', announce: true },
  conflict: { label: 'Conflict', icon: 'alert-triangle', tone: 'bad', announce: true },
};

/** The autosave state as an icon and one word, beside the next-step button. */
export function SaveState({ status }: { status: SyncStatus }) {
  const look = LOOKS[status];
  return (
    <span role="status" className={styles.saveState} data-tone={look?.tone}>
      {look ? (
        <>
          {look.icon ? <Icon name={look.icon} size={16} /> : null}
          <span aria-hidden={look.announce ? undefined : true}>{look.label}</span>
        </>
      ) : null}
    </span>
  );
}

const excerpt = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Shown when the stored draft and the text on this page disagree. It cannot be dismissed without a choice, because
 * either answer replaces someone's text.
 */
export function ConflictDialog({
  conflict,
  onChoose,
}: {
  conflict: DraftConflict | null;
  onChoose: (choice: 'mine' | 'theirs') => void;
}) {
  const other = conflict?.current.values ?? null;
  return (
    <Dialog
      open={conflict !== null}
      locked
      closeOnOutsideClick={false}
      size="small"
      title={conflict?.kind === 'removed' ? 'Draft deleted elsewhere' : 'Draft changed elsewhere'}
      description={
        conflict?.kind === 'removed'
          ? 'This draft was deleted or submitted in another tab. Keep what is on this page, or start over.'
          : 'A different version of this draft is saved. Pick the one to keep; the other is replaced.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onChoose('theirs')}>
            {conflict?.kind === 'removed' ? 'Start over' : 'Use saved version'}
          </Button>
          <Button onClick={() => onChoose('mine')}>Keep this page</Button>
        </>
      }
    >
      {other ? (
        <div className={styles.conflictChoices}>
          <p>
            <strong>Saved version</strong>
            <br />
            {other.title ? `${other.title}. ` : ''}
            {other.body ? excerpt(other.body) : 'No body yet.'}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}

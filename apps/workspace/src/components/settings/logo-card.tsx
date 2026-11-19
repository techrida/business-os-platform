'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import { FormStatus } from '@/app/(app)/settings/form-status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Panel } from '@/components/ui/panel';

import {
  LOGO_ACCEPT,
  LOGO_HINT,
  isLogoDataUrl,
  validateLogoFile,
  type LogoDraft,
} from './company-profile';
import styles from './company-editor.module.css';

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('unreadable'));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

/**
 * The logo card. Dropping or choosing a file saves it at once (UIP-FORM-001), so this card has no
 * Save button. Click the picture to see it larger in a dialog (UIP-FORM-003); the remove button
 * asks before it deletes (UIP-FORM-002, UIP-FEED-002). `draft` is what the preview shows: the
 * picked file while it saves, the saved logo otherwise. `onDraft(undefined)` hands the preview
 * back to the saved logo.
 */
export function LogoCard({
  draft,
  onDraft,
  action,
}: {
  draft: LogoDraft;
  onDraft: (next: LogoDraft | undefined) => void;
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [, startTransition] = useTransition();
  const [over, setOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const onDraftRef = useRef(onDraft);
  useEffect(() => {
    onDraftRef.current = onDraft;
  });
  // Saved or refused: the preview goes back to what is stored (the page already holds the new value).
  useEffect(() => {
    if (state.status !== 'idle') onDraftRef.current(undefined);
  }, [state]);

  const save = (value: string | null) => {
    const data = new FormData();
    data.set('card', 'logo');
    data.set('logo', value ?? '');
    startTransition(() => formAction(data));
  };

  const pick = async (file: File) => {
    setLocalError(null);
    const check = validateLogoFile(file);
    if (!check.ok) {
      setLocalError(check.message);
      return;
    }
    try {
      const url = await readAsDataUrl(file);
      if (!isLogoDataUrl(url)) {
        setLocalError('That image cannot be saved. ' + LOGO_HINT + '.');
        return;
      }
      onDraft(url);
      save(url);
    } catch {
      setLocalError('That file could not be read. Try another image.');
    }
  };

  const error = localError ?? (state.status === 'error' ? state.fieldErrors?.['logo'] : undefined);
  const errorId = 'logo-error';

  return (
    <Panel title="Logo" description="Printed at the top of your quotations and invoices.">
      <div className={shell.form}>
        <div className={styles.logo} data-empty={draft ? undefined : 'true'}>
          {draft ? (
            <Dialog
              trigger={
                <button type="button" className={styles.thumb} aria-label="Preview logo">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a data URL the person chose: drawn through <img> only */}
                  <img className={styles.thumbImage} src={draft} alt="Current logo" />
                </button>
              }
              title="Logo preview"
              size="medium"
              footer={
                <DialogClose asChild>
                  <Button variant="secondary">Close</Button>
                </DialogClose>
              }
            >
              <div className={styles.previewStage}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL the person chose */}
                <img className={styles.previewImage} src={draft} alt="Current logo" />
              </div>
            </Dialog>
          ) : null}
          <label
            className={styles.drop}
            data-over={over ? 'true' : undefined}
            data-busy={pending ? 'true' : undefined}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              const file = event.dataTransfer.files[0];
              if (file && !pending) void pick(file);
            }}
          >
            <input
              type="file"
              accept={LOGO_ACCEPT}
              className="sr-only"
              disabled={pending}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void pick(file);
              }}
            />
            <span className={styles.dropTitle}>
              {draft
                ? 'Drop a new logo here, or choose a file'
                : 'Drop your logo here, or choose a file'}
            </span>
            <span className={styles.help}>{LOGO_HINT}</span>
          </label>
        </div>
        {error ? (
          <span id={errorId} className={styles.error} role="alert">
            {error}
          </span>
        ) : null}
        <div className={styles.logoActions}>
          {draft ? (
            <ConfirmDialog
              trigger={
                <Button variant="secondary" size="small" disabled={pending}>
                  <Icon name="x" size={16} />
                  Remove logo
                </Button>
              }
              title="Remove the logo?"
              description="Documents you make from now on print without a logo. You can add one again at any time."
              confirmLabel="Remove logo"
              destructive
              onConfirm={() => {
                onDraft(null);
                save(null);
              }}
            />
          ) : null}
          <div className={shell.status}>
            <FormStatus state={state} pending={pending} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

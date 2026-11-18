'use client';

import { useEffect, useId, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import styles from './transaction-dialog.module.css';

export { ErrorSummary, PendingLine, useFocusOnProblem } from '../p2/quotations/action-dialog';

/**
 * The frame for transaction forms that put their actions inside a native modal dialog. The browser traps focus inside, closes on Esc and puts focus back on
 * the trigger. Cancel and Done inside it use `DialogCloseButton`.
 */
export function ActionDialog({
  triggerLabel,
  triggerVariant = 'secondary',
  title,
  intro,
  children,
}: {
  triggerLabel: string;
  triggerVariant?: 'primary' | 'secondary';
  title: string;
  /** Said once under the title, before any field. */
  intro: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const introId = useId();
  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();
  // The dialog has no padding, so only a click on the dim area reports the dialog as its target.
  const closeOnBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) close();
  };

  return (
    <>
      <Button variant={triggerVariant} onClick={open}>
        {triggerLabel}
      </Button>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={introId}
        onClick={closeOnBackdrop}
      >
        <div className={styles.dialogBox}>
          <div className={styles.dialogHead}>
            <div className={styles.dialogTitle}>
              <h2 id={titleId}>{title}</h2>
              <p id={introId} className={styles.dialogSub}>
                {intro}
              </p>
            </div>
            <Button
              variant="ghost"
              size="small"
              className={styles.dialogClose ?? ''}
              onClick={close}
              aria-label="Close"
            >
              <Icon name="x" size={18} />
            </Button>
          </div>
          <div className={styles.dialogBody}>{children}</div>
        </div>
      </dialog>
    </>
  );
}

/** A button that closes the dialog it sits in. Reads the dialog from the DOM, so it needs no ref. */
export function DialogCloseButton({
  variant = 'secondary',
  disabled,
  children,
}: {
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant={variant}
      disabled={disabled}
      onClick={(e) => e.currentTarget.closest('dialog')?.close()}
    >
      {children}
    </Button>
  );
}

/**
 * Once the API has accepted the request, the dialog says so; closing it (Done, the X or Esc) then
 * reloads the page, so it shows the new status. A full reload is what guarantees the new version.
 */
export function useReloadWhenClosed(
  done: boolean | undefined,
  wrapRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (done !== true) return;
    const dialog = wrapRef.current?.closest('dialog');
    const reload = () => window.location.reload();
    dialog?.addEventListener('close', reload);
    return () => dialog?.removeEventListener('close', reload);
  }, [done, wrapRef]);
}

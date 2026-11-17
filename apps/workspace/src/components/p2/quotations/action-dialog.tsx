'use client';

import { useEffect, useId, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import styles from './actions.module.css';
import detail from './detail.module.css';

/**
 * The frame shared by Send, Record outcome and Revise: a trigger button and a native modal dialog,
 * as in the revisions dialog. The browser traps focus inside, closes on Esc and puts focus back on
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
        className={`${detail.dialog} ${styles.dialogNarrow}`}
        aria-labelledby={titleId}
        aria-describedby={introId}
        onClick={closeOnBackdrop}
      >
        <div className={detail.dialogBox}>
          <div className={detail.dialogHead}>
            <div className={detail.dialogTitle}>
              <h2 id={titleId}>{title}</h2>
              <p id={introId} className={detail.dialogSub}>
                {intro}
              </p>
            </div>
            <Button
              variant="ghost"
              size="small"
              className={detail.dialogClose ?? ''}
              onClick={close}
              aria-label="Close"
            >
              <Icon name="x" size={18} />
            </Button>
          </div>
          <div className={detail.dialogBody}>{children}</div>
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

/** What a refused action says, with a plain link to reload when the page is out of date. */
export function ErrorSummary({
  error,
  reload,
  reloadHref,
  summaryRef,
  reloadLabel = 'Reload this quotation',
}: {
  reloadLabel?: string;
  error: string | undefined;
  reload: boolean | undefined;
  reloadHref: string;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  if (!error) return null;
  return (
    <Alert
      ref={summaryRef}
      tabIndex={-1}
      tone="error"
      role="alert"
      actions={reload ? <a href={reloadHref}>{reloadLabel}</a> : null}
    >
      {error}
    </Alert>
  );
}

/**
 * Moves focus to what went wrong after a refusal, so a keyboard or screen reader user lands on it:
 * the summary for an API refusal, the first wrong field for a validation one.
 */
export function useFocusOnProblem(
  state: { error?: string | undefined; errors?: object | undefined },
  wrapRef: RefObject<HTMLElement | null>,
  summaryRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else if (state.errors && Object.keys(state.errors).length > 0) {
      wrapRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"], fieldset[data-invalid] input')
        ?.focus();
    }
  }, [state, wrapRef, summaryRef]);
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

/** The line under the buttons that tells a screen reader the request is on its way. */
export function PendingLine({ pending, words }: { pending: boolean; words: string }) {
  return (
    <p className={styles.status} role="status">
      {pending ? words : ''}
    </p>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useCallback, useEffect, type ReactNode, type RefObject } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';

import styles from './actions.module.css';

/**
 * Re-renders the server page after an action dialog closes on success, in a transition, so the record's new version and
 * history arrive without reloading the document. The forms that call this are keyed on the record version (or the
 * render's idempotency key), so the next action starts from the new expected version, never the one just used.
 */
export function useRefreshAfterAction(): () => void {
  const router = useRouter();
  return useCallback(() => startTransition(() => router.refresh()), [router]);
}

/** The quotation action dialogs share a fixed submit footer and refresh after a confirmed change. */
export function ActionDialog({
  triggerLabel,
  triggerVariant = 'secondary',
  title,
  intro,
  formId,
  submitLabel,
  pending,
  done,
  blocked = false,
  children,
}: {
  triggerLabel: string;
  triggerVariant?: 'primary' | 'secondary';
  title: string;
  /** Said once under the title, before any field. */
  intro: ReactNode;
  formId: string;
  submitLabel: string;
  pending: boolean;
  done?: boolean | undefined;
  /** Keeps the submit button off while a field is not ready (a file still uploading, an infected file). */
  blocked?: boolean | undefined;
  children: ReactNode;
}) {
  const refreshAfterAction = useRefreshAfterAction();
  return (
    <Dialog
      trigger={<Button variant={triggerVariant}>{triggerLabel}</Button>}
      title={title}
      description={intro}
      locked={pending}
      onOpenChange={(open) => {
        if (!open && done) refreshAfterAction();
      }}
      footer={
        done ? (
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              form={formId}
              disabled={pending || blocked}
              aria-busy={pending || undefined}
            >
              {submitLabel}
            </Button>
          </>
        )
      }
    >
      {children}
    </Dialog>
  );
}

/** What a refused action says, with a plain link to reload when the page is out of date. */
export function ErrorSummary({
  error,
  reload,
  reloadHref,
  reloadLabel = 'Reload this quotation',
  summaryRef,
}: {
  error: string | undefined;
  reload: boolean | undefined;
  reloadHref: string;
  reloadLabel?: string;
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
    focusProblem(state, wrapRef.current, summaryRef.current);
  }, [state, wrapRef, summaryRef]);
}

/** The focus move of `useFocusOnProblem`, for a caller that must repeat it on its own event. */
export function focusProblem(
  state: { error?: string | undefined; errors?: object | undefined },
  wrap: HTMLElement | null,
  summary: HTMLElement | null,
): void {
  if (state.error) summary?.focus();
  else if (state.errors && Object.keys(state.errors).length > 0) {
    wrap
      ?.querySelector<HTMLElement>('[aria-invalid="true"], fieldset[data-invalid] input')
      ?.focus();
  }
}

/** Announces the pending request while the footer actions are disabled. */
export function PendingLine({ pending, words }: { pending: boolean; words: string }) {
  return (
    <p className={styles.status} role="status">
      {pending ? words : ''}
    </p>
  );
}

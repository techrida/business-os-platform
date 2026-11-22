'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { Button } from './button';
import { Icon } from './icon';
import { PopoverContainerContext } from './popover-container';
import styles from './dialog.module.css';

export type DialogSize = 'small' | 'medium' | 'large' | 'full';

export interface DialogProps {
  /**
   * The element that opens the dialog, usually a `<Button>`. It is rendered as the trigger itself
   * (Radix `asChild`), so it keeps its own element and gets `aria-haspopup`, `aria-expanded` and the
   * focus return. Omit it for a dialog opened only through `open`.
   */
  trigger?: ReactNode | undefined;
  /** Controlled state. Pair with `onOpenChange`. */
  open?: boolean | undefined;
  /** Uncontrolled initial state. */
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** The accessible name and the visible heading. Required. */
  title: ReactNode;
  /** One or two sentences under the title. Also the accessible description. */
  description?: ReactNode | undefined;
  /** The scrolling area. */
  children?: ReactNode | undefined;
  /**
   * Action buttons. They sit in a bar fixed to the bottom of the dialog, outside the scrolling body, so they
   * stay visible however long the body is. A button that belongs to a form in the body names it with
   * `form="the-form-id"`, and a plain `type="submit"` button then submits it.
   */
  footer?: ReactNode | undefined;
  size?: DialogSize | undefined;
  /** Marks the dialog as asking for a risky confirmation. It only changes the look of the title icon. */
  tone?: 'default' | 'destructive' | undefined;
  /** Where focus starts. Default: the first focusable thing in the body, else the first footer button. */
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /**
   * Runs as the dialog closes, before focus returns to the trigger (Radix `onCloseAutoFocus`). Call
   * `event.preventDefault()` and focus an element yourself, for example the opener of a dialog with no `trigger`.
   */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
  /** Escape, a click outside and the close button do nothing while true (a request is in flight). */
  locked?: boolean | undefined;
  /** Set false for a dialog holding unsaved input, so a stray click outside cannot discard it. Escape still closes. */
  closeOnOutsideClick?: boolean | undefined;
  /** Accessible name of the close button. */
  closeLabel?: string | undefined;
  className?: string | undefined;
  bodyClassName?: string | undefined;
}

/**
 * A modal dialog on Radix (https://www.radix-ui.com/primitives/docs/components/dialog), which provides the
 * WAI-ARIA dialog pattern: focus moves in, Tab is trapped, Escape closes, focus returns to the opener, the
 * rest of the page is inert. We add the layout: a fixed header, a body that scrolls on its own, and a fixed
 * footer for the actions (UIP-DLG-001).
 *
 * @example
 *   <Dialog
 *     trigger={<Button variant="secondary">Rename</Button>}
 *     title="Rename memo"
 *     footer={<>
 *       <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
 *       <Button type="submit" form="rename-form">Save</Button>
 *     </>}
 *   >
 *     <form id="rename-form" action={renameAction}>...</form>
 *   </Dialog>
 */
export function Dialog({
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'medium',
  tone = 'default',
  initialFocusRef,
  onCloseAutoFocus,
  locked = false,
  closeOnOutsideClick = true,
  closeLabel = 'Close',
  className,
  bodyClassName,
}: DialogProps) {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const scrolls = useOverflow(body);
  const root: RadixDialog.DialogProps = {
    ...(open !== undefined ? { open } : {}),
    ...(defaultOpen !== undefined ? { defaultOpen } : {}),
    ...(onOpenChange ? { onOpenChange } : {}),
  };
  return (
    <RadixDialog.Root {...root}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          ref={setContentEl}
          className={[styles.content, styles[size], className].filter(Boolean).join(' ')}
          {...(description ? {} : { 'aria-describedby': undefined })}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
          onOpenAutoFocus={(event) => {
            const target = initialFocusRef?.current;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            // Escape first closes an open dropdown list; only a second press closes the dialog.
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('[role="listbox"], [aria-expanded="true"]')) event.preventDefault();
            if (locked) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (locked || !closeOnOutsideClick) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            // Toasts and other portalled UI live outside the dialog; a click there is not a dismissal.
            if (locked || !closeOnOutsideClick) event.preventDefault();
          }}
        >
          <PopoverContainerContext value={contentEl ?? undefined}>
            <header className={styles.header}>
              {tone === 'destructive' ? (
                <span className={styles.titleIcon}>
                  <Icon name="alert-triangle" size={20} />
                </span>
              ) : null}
              <div className={styles.headerText}>
                <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
                {description ? (
                  <RadixDialog.Description className={styles.description}>
                    {description}
                  </RadixDialog.Description>
                ) : null}
              </div>
            </header>
            <div
              ref={setBody}
              className={[styles.body, bodyClassName].filter(Boolean).join(' ')}
              // A scrolling region must be reachable by keyboard; only add the stop when there is something to scroll.
              {...(scrolls ? { tabIndex: 0 } : {})}
            >
              {children}
            </div>
            {footer ? <footer className={styles.footer}>{footer}</footer> : null}
            {/* After the body in the DOM so the first Tab stop is the content, positioned top-right by CSS. */}
            <RadixDialog.Close asChild>
              <button
                type="button"
                className={styles.close}
                aria-label={closeLabel}
                disabled={locked}
              >
                <Icon name="x" size={20} />
              </button>
            </RadixDialog.Close>
          </PopoverContainerContext>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Closes the enclosing dialog. Use `asChild` on a `<Button>`: `<DialogClose asChild><Button>Cancel</Button></DialogClose>`. */
export const DialogClose = RadixDialog.Close;

export interface ConfirmDialogProps {
  trigger?: ReactNode | undefined;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  title: ReactNode;
  /** What will happen, in a sentence. */
  description?: ReactNode | undefined;
  /** Optional extra content, for example the name of the item. */
  children?: ReactNode | undefined;
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /** Red confirm button, warning icon, and focus starts on Cancel so Enter cannot confirm by accident. */
  destructive?: boolean | undefined;
  /**
   * Runs on confirm. While the promise is pending both buttons are disabled and the dialog cannot be dismissed.
   * The dialog closes when it resolves; if it throws or resolves to `false` the dialog stays open (the caller shows
   * the failure, for example with a toast or an Alert inside `children`).
   */
  onConfirm: () => void | boolean | Promise<void | boolean>;
  size?: DialogSize | undefined;
}

/**
 * A short confirmation (UIP-FEED-002): title, one sentence, Cancel and a confirm button in the fixed footer.
 *
 * @example
 *   <ConfirmDialog
 *     trigger={<Button variant="ghost" aria-label="Delete draft"><Icon name="x" /></Button>}
 *     title="Delete this draft?"
 *     description="The draft and its attachments are removed. This cannot be undone."
 *     confirmLabel="Delete draft"
 *     destructive
 *     onConfirm={async () => { await deleteDraft(); }}
 *   />
 */
export function ConfirmDialog({
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  size = 'small',
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [innerOpen, setInnerOpen] = useState(defaultOpen ?? false);
  const [pending, setPending] = useState(false);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : innerOpen;

  function setOpen(next: boolean) {
    if (!controlled) setInnerOpen(next);
    onOpenChange?.(next);
  }

  async function confirm() {
    setPending(true);
    try {
      const result = await onConfirm();
      if (result !== false) setOpen(false);
    } catch {
      // Stay open; the caller reports the failure.
    } finally {
      setPending(false);
    }
  }

  const props: DialogProps = {
    open: isOpen,
    onOpenChange: setOpen,
    title,
    size,
    className: styles.confirm,
    tone: destructive ? 'destructive' : 'default',
    locked: pending,
    closeOnOutsideClick: !destructive,
    ...(trigger ? { trigger } : {}),
    ...(description ? { description } : {}),
    ...(destructive ? { initialFocusRef: cancelRef } : {}),
    footer: (
      <>
        <Button
          ref={cancelRef}
          variant="secondary"
          className={destructive ? styles.dangerCancel : undefined}
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          {cancelLabel}
        </Button>
        <Button
          className={destructive ? styles.danger : undefined}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </Button>
      </>
    ),
  };
  return <Dialog {...props}>{children}</Dialog>;
}

/** True while the element's content is taller or wider than its box. */
function useOverflow(el: HTMLElement | null): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    if (!el) return;
    const measure = () =>
      setOverflows(el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [el]);
  return overflows;
}

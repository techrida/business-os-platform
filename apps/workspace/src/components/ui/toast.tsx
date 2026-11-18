'use client';

import type { ReactNode } from 'react';
import { Toaster, toast as sonner } from 'sonner';

import { Icon, type IconName } from './icon';
import styles from './toast.module.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  /** A second, quieter line. Keep it short: a toast is read in a glance. */
  description?: ReactNode;
  /** Milliseconds on screen. Defaults: 4000 (5000 with an action), 8000 for errors. `Infinity` keeps it until dismissed. */
  duration?: number;
  /** Re-using an id updates that toast in place, so repeated events do not stack. */
  id?: string | number;
  /** One optional follow-up, for example "Undo". The toast closes after it runs. */
  action?: { label: string; onClick: () => void };
}

const ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  error: 'x-circle',
};

export const TOAST_DURATION_MS = 4000;
export const TOAST_ACTION_DURATION_MS = 5000;
export const TOAST_ERROR_DURATION_MS = 8000;

function show(tone: ToastTone, title: ReactNode, options: ToastOptions = {}) {
  const duration =
    options.duration ??
    (tone === 'error'
      ? TOAST_ERROR_DURATION_MS
      : options.action
        ? TOAST_ACTION_DURATION_MS
        : TOAST_DURATION_MS);
  return sonner.custom(
    (id) => (
      <ToastCard
        tone={tone}
        title={title}
        description={options.description}
        action={options.action}
        onDismiss={() => sonner.dismiss(id)}
      />
    ),
    { ...(options.id === undefined ? {} : { id: options.id }), duration },
  );
}

/**
 * Transient in-app feedback ("File downloaded", "Moved to Contacted", a failed save). Call it from
 * client code (event handlers, callbacks); it does nothing on the server, so return the result
 * from a server action and toast where it is received. Never put information here that the user
 * must still be able to find later: that belongs in a persistent notification (the bell) or inline.
 *
 *   toast.success('File downloaded');
 *   toast.error('Could not save', { description: 'The memo is locked.' });
 *   toast.info('Moved to Contacted', { action: { label: 'Undo', onClick: undo } });
 *
 * Each call returns the toast id; `toast.dismiss(id)` closes one, `toast.dismiss()` all of them.
 */
export const toast = Object.assign(
  (title: ReactNode, options?: ToastOptions) => show('info', title, options),
  {
    info: (title: ReactNode, options?: ToastOptions) => show('info', title, options),
    success: (title: ReactNode, options?: ToastOptions) => show('success', title, options),
    warning: (title: ReactNode, options?: ToastOptions) => show('warning', title, options),
    error: (title: ReactNode, options?: ToastOptions) => show('error', title, options),
    dismiss: (id?: string | number) => sonner.dismiss(id),
  },
);

function ToastCard({
  tone,
  title,
  description,
  action,
  onDismiss,
}: {
  tone: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ToastOptions['action'];
  onDismiss: () => void;
}) {
  return (
    // Sonner's list item is already a polite live region; an error adds role="alert" so it is
    // announced at once.
    <div
      className={`${styles.toast} ${styles[tone]}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      <Icon name={ICON[tone]} size={20} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        {description ? <p className={styles.description}>{description}</p> : null}
        {action ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              action.onClick();
              onDismiss();
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>
      <button type="button" className={styles.close} onClick={onDismiss} aria-label="Dismiss">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

/**
 * Mount once, in the root layout. Toasts stack at the top right under the header, collapse behind
 * the newest, expand on hover or focus, pause their timer while hovered, and can be swiped away
 * or closed with the x. Alt+T moves focus into the stack. Sonner supplies the stacking, timers
 * and swipe; the look is ours (toast.module.css, --toast-* tokens).
 */
export function WorkspaceToaster() {
  return (
    <Toaster
      className={styles.toaster ?? ''}
      position="top-right"
      visibleToasts={4}
      gap={8}
      duration={TOAST_DURATION_MS}
      offset={{ top: 'calc(var(--bos-header-height) + 12px)', right: 16 }}
      mobileOffset={{
        top: 'calc(var(--bos-header-height) + env(safe-area-inset-top, 0px) + 8px)',
        left: 'max(12px, env(safe-area-inset-left, 0px))',
        right: 'max(12px, env(safe-area-inset-right, 0px))',
      }}
      containerAriaLabel="Notifications"
    />
  );
}

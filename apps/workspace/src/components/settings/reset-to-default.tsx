'use client';

import type { SettingKey } from '@bos/contracts';
import { useState } from 'react';

import type { ActionState } from '@/app/(app)/settings/action-state';
import { resetSettingAction } from '@/app/(app)/settings/_components/actions';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { toast } from '@/components/ui/toast';
import type { SettingsSectionId } from '@/lib/settings-nav';

import styles from './reset-to-default.module.css';

export interface ResetConfirm {
  title: string;
  body: string;
  confirmLabel: string;
}

export interface ResetToDefaultButtonProps {
  section: SettingsSectionId;
  settingKey: SettingKey;
  /** The setting's name as the person reads it: "Default VAT rate (%)". */
  label: string;
  /** True when the saved value already equals the default. Nothing is drawn then. */
  isDefault: boolean;
  /** The default as short text for the tooltip (`defaultText(key)`, or the screen's own wording). */
  defaultText: string;
  /** Only for a setting whose reset is destructive: asks first, in a dialog. Otherwise it resets at once. */
  confirm?: ResetConfirm | undefined;
  /** Where the screen places it (beside the label or the value). */
  className?: string | undefined;
  /**
   * Replaces the default whole-setting reset, for a part of a setting (one currency of the number format, one
   * company card). It must itself write through the section's guard and return the action state.
   */
  action?: (() => Promise<ActionState>) | undefined;
}

const resetLabel = (label: string): string => `Reset ${label} to default`;
const resetTitle = (defaultText: string): string => `Reset to default (${defaultText})`;

/**
 * Shown only while a setting differs from its default (D32). Pressing it saves the default as a
 * normal new version (so it lands in the audit trail), then a toast says so (UIP-FEED-001). A
 * destructive setting asks in a dialog first (UIP-FEED-002). The page revalidates, so the screen
 * then shows the default and this button disappears.
 *
 * Put it beside the field, not inside its `<label>`: it must not change the control's name. It is
 * `type="button"`, so inside a form it never submits it.
 */
export function ResetToDefaultButton({
  section,
  settingKey,
  label,
  isDefault,
  defaultText,
  confirm,
  className,
  action,
}: ResetToDefaultButtonProps) {
  const [busy, setBusy] = useState(false);
  if (isDefault) return null;

  // Resolves true when the setting was reset. A refusal or a failed request is a toast, and the
  // setting stays as it was.
  const reset = async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const state = await (action ? action() : resetSettingAction(section, settingKey));
      if (state.status === 'error') {
        toast.error(state.message.split('\n')[0] ?? state.message, { id: `reset:${settingKey}` });
        return false;
      }
      toast.success(`${label} reset to default`, { id: `reset:${settingKey}` });
      return true;
    } catch {
      toast.error(`${label} could not be reset. Try again.`, { id: `reset:${settingKey}` });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const button = (
    <button
      type="button"
      className={[styles.button, className].filter(Boolean).join(' ')}
      aria-label={resetLabel(label)}
      title={resetTitle(defaultText)}
      aria-busy={busy || undefined}
      {...(confirm ? {} : { onClick: () => void reset() })}
    >
      <Icon name="undo-2" size={16} />
    </button>
  );

  if (!confirm) return button;
  return (
    <ConfirmDialog
      trigger={button}
      title={confirm.title}
      description={confirm.body}
      confirmLabel={confirm.confirmLabel}
      destructive
      onConfirm={reset}
    />
  );
}

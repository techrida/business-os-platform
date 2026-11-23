'use client';

import resetStyles from '@/components/settings/reset-to-default.module.css';
import { Icon } from '@/components/ui/icon';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * The D32 undo icon for one access value. Unlike the Settings reset, it never saves by itself:
 * the caller resets a staged value or opens the review dialog with that single change (spec 7.3).
 * `name` says what it resets and to what: "Reset Sales on Leads to the default: Their own".
 */
export function UndoButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Tooltip content={name}>
      <button type="button" className={resetStyles.button} aria-label={name} onClick={onClick}>
        <Icon name="undo-2" size={16} />
      </button>
    </Tooltip>
  );
}

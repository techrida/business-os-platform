'use client';

import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import styles from './departments.module.css';

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
}

/**
 * The "More" button of a phone card. Unlike RowMenu (links only) its items are buttons that open
 * a dialog. It is a popover of buttons, not a `role="menu"` widget: Tab walks the items, Escape
 * closes it and focus returns to the button. Renders nothing when there is nothing to do.
 */
export function ActionMenu({ label, items }: { label: string; items: readonly ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="small" className={styles.iconButton} aria-label={label}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="12" cy="5" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="12" cy="19" r="1.75" />
          </svg>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.menuContent}
          aria-label={label}
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={16}
        >
          <ul className={styles.menuList}>
            {items.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

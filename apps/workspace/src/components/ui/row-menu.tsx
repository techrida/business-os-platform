'use client';

import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';

import { Button } from './button';
import styles from './row-menu.module.css';

export interface RowMenuItem {
  label: string;
  href: string;
}

/**
 * The kebab (three dots) at the end of a table row. It opens a short list of links for that row,
 * so a row can grow a second action without a second column. Give it only the actions the viewer
 * may take, and render nothing when there are none: an empty menu is worse than no menu.
 *
 * It is a popover of links, not a `role="menu"` widget: the button is announced as expandable,
 * Tab walks the links, Escape closes it and focus returns to the button.
 */
export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  if (items.length === 0) return null;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="small" className={styles.trigger} aria-label={label}>
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
          className={styles.content}
          aria-label={label}
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={16}
        >
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.href}>
                <Popover.Close asChild>
                  <Link href={item.href} className={styles.item}>
                    {item.label}
                  </Link>
                </Popover.Close>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

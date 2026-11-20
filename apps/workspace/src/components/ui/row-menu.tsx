'use client';

import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';
import { useRef, useState, type KeyboardEvent } from 'react';

import { Button } from './button';
import {
  DROPDOWN_CONTAINER_PADDING,
  DROPDOWN_POPOVER_OFFSET,
  usePopoverContainer,
} from './popover-container';
import styles from './row-menu.module.css';

export type RowMenuItem = { label: string; href: string } | { label: string; onSelect: () => void };

/**
 * The kebab (three dots) at the end of a table row or card. Opens a short popover of links or
 * action buttons using the shared dropdown panel surface, 8 px offset and collision flipping.
 * Give it only the actions the viewer may take, and render nothing when there are none.
 *
 * It is a non-listbox popover (`@radix-ui/react-popover`), not a `role="menu"` widget: Tab and
 * Arrow/Home/End walk the items, Enter activates, Escape closes and returns focus to the trigger.
 */
export function RowMenu({
  label,
  items,
  triggerClassName,
}: {
  label: string;
  items: readonly RowMenuItem[];
  triggerClassName?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const container = usePopoverContainer();

  if (items.length === 0) return null;

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    const focusables = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [],
    );
    if (focusables.length === 0) return;
    event.preventDefault();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const index = active ? focusables.indexOf(active) : -1;
    let nextIndex: number;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = focusables.length - 1;
    else if (event.key === 'ArrowDown') {
      nextIndex = index === -1 ? 0 : (index + 1) % focusables.length;
    } else {
      nextIndex =
        index === -1 ? focusables.length - 1 : (index - 1 + focusables.length) % focusables.length;
    }
    focusables[nextIndex]?.focus();
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="small"
          className={[styles.trigger, triggerClassName].filter(Boolean).join(' ')}
          aria-label={label}
        >
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
      <Popover.Portal container={container}>
        <Popover.Content
          className={styles.content}
          aria-label={label}
          side="bottom"
          align="end"
          sideOffset={DROPDOWN_POPOVER_OFFSET}
          collisionPadding={DROPDOWN_CONTAINER_PADDING}
          avoidCollisions
          onKeyDown={onListKeyDown}
        >
          <ul ref={listRef} className={styles.list}>
            {items.map((item) =>
              'href' in item ? (
                <li key={item.href}>
                  <Popover.Close asChild>
                    <Link href={item.href} className={styles.item}>
                      {item.label}
                    </Link>
                  </Popover.Close>
                </li>
              ) : (
                <li key={item.label}>
                  <button
                    type="button"
                    className={styles.item}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                </li>
              ),
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

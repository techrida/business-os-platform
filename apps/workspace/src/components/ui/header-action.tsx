'use client';

import * as Popover from '@radix-ui/react-popover';
import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';

import { Badge } from './badge';
import { Button } from './button';
import styles from './header-action.module.css';

/** Short labels for what is still needed, in the order to show them: `['Subject', 'Body']`. Labels must be unique. */
export type MissingItems = readonly string[];

/** Red pills, one per missing item. Renders nothing for an empty list. */
export function MissingPills({
  items,
  label = 'Missing',
  className,
}: {
  items: MissingItems;
  /** Accessible name of the list. */
  label?: string | undefined;
  className?: string | undefined;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={[styles.pills, className].filter(Boolean).join(' ')} aria-label={label}>
      {items.map((item) => (
        <li key={item}>
          <Badge tone="error">{item}</Badge>
        </li>
      ))}
    </ul>
  );
}

type ButtonProps = Omit<ComponentPropsWithRef<typeof Button>, 'children'>;

export interface HeaderActionProps extends ButtonProps {
  /** The button label. */
  children: ReactNode;
  /**
   * What is still missing. Empty or omitted: a normal enabled button. One or more items: the button is
   * blocked (it never submits or runs `onClick`) but stays focusable; activating it explains what is missing.
   */
  missing?: MissingItems | undefined;
  /** Show the red pills beside the button. Default true. */
  pills?: boolean | undefined;
  /** Heading of the explanation popover. */
  missingTitle?: string | undefined;
  /** Accessible name of the pill list. */
  missingLabel?: string | undefined;
}

/**
 * The primary action of a page header (Submit, Send, Approve) with its missing requirements.
 *
 * When something is missing the button is `aria-disabled="true"`, not `disabled`, so it still takes focus and a
 * tap or click. Activating it (pointer, Enter or Space) opens a small popover listing what is missing; Escape
 * closes it and focus returns to the button. Because the button is always `type="button"` while blocked, it cannot
 * submit a form, with or without a `form` attribute. Assistive technology hears the missing items through
 * `aria-describedby`, so the explanation does not depend on opening the popover. Once nothing is missing it
 * becomes an ordinary button; pass `type="submit"` and `form="the-form-id"` when the form is outside the header.
 *
 * It does not replace `PageHeader`: place it in whatever slot the header offers for actions.
 *
 * @example
 *   <HeaderAction type="submit" form="memo-form" missing={missing}>Submit for review</HeaderAction>
 *   // missing = ['Subject', 'Approver'] -> two red pills, blocked button; [] -> enabled
 */
export function HeaderAction({
  children,
  missing = [],
  pills = true,
  missingTitle = 'Still needed',
  missingLabel = 'Missing',
  className,
  disabled,
  onClick,
  type = 'button',
  ...rest
}: HeaderActionProps) {
  const descriptionId = useId();
  const explanationTitleId = useId();
  const blocked = missing.length > 0;

  return (
    <div className={styles.root}>
      {pills ? <MissingPills items={missing} label={missingLabel} /> : null}
      {blocked ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              {...rest}
              // Never `disabled`: it must keep focus and clicks. Never a submit: it must not post the form.
              type="button"
              aria-disabled="true"
              aria-describedby={descriptionId}
              className={[styles.blocked, className].filter(Boolean).join(' ')}
            >
              {children}
            </Button>
          </Popover.Trigger>
          <span id={descriptionId} className="sr-only">
            {`${missingLabel}: ${missing.join(', ')}`}
          </span>
          <Popover.Portal>
            <Popover.Content
              className={styles.popover}
              aria-labelledby={explanationTitleId}
              side="bottom"
              align="end"
              sideOffset={8}
              collisionPadding={16}
            >
              <p id={explanationTitleId} className={styles.popoverTitle}>
                {missingTitle}
              </p>
              <ul className={styles.list}>
                {missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <Popover.Arrow className={styles.arrow} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <Button {...rest} type={type} className={className} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      )}
    </div>
  );
}

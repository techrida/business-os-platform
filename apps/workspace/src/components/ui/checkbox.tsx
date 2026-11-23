'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { type ComponentPropsWithoutRef, type MouseEvent, type ReactNode, type Ref } from 'react';

import styles from './checkbox.module.css';
import { Tooltip } from './tooltip';

// UIP-BUILD-002: the browser's own tick box and radio dot are not allowed in the apps (lint blocks a bare
// `<input type="checkbox|radio">`). These are the design-system controls. Both are buttons with the
// checkbox / radio ARIA role, so a label that wraps them (or `htmlFor` + `id`) names them and a click on
// the label toggles them; inside a `<form>` they submit `name`/`value` like a native input would.

// Radix listens for the form's `reset` event. React 19 resets a form after every `<form action>`
// completes, so two things go wrong for a control the parent holds in state (a native controlled input
// is re-synced by React; Radix's is not):
//  1. Radix calls onCheckedChange / onValueChange with the value the control had when it mounted, so the
//     screen would flip back to the first value. The handlers below skip changes made during a reset.
//  2. The reset also puts Radix's hidden form input back to that first value, and it is only re-synced
//     when the checked state changes, which the guard prevents. So, once the reset has finished, each
//     hidden input is set again from its button's `aria-checked`, and the form posts what the screen
//     shows. An uncontrolled control still returns to its default through Radix's own state.
let resetting = false;

function resyncHiddenInputs(form: HTMLFormElement) {
  for (const button of form.querySelectorAll<HTMLButtonElement>(
    'button[role="checkbox"], button[role="radio"]',
  )) {
    const input = button.nextElementSibling;
    if (input instanceof HTMLInputElement && input.getAttribute('aria-hidden') === 'true') {
      input.checked = button.getAttribute('aria-checked') === 'true';
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener(
    'reset',
    (event) => {
      resetting = true;
      queueMicrotask(() => {
        resetting = false;
      });
      const form = event.target;
      // The form's controls are reset after the event, and Radix's own reset handling re-renders
      // after that, so look again on the next task.
      if (form instanceof HTMLFormElement) setTimeout(() => resyncHiddenInputs(form), 0);
    },
    true,
  );
}

const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

interface DisabledReason {
  /**
   * Blocks the control for now and says why in a tooltip. The control stays focusable and carries
   * `aria-disabled`, so keyboard and screen-reader users can reach the reason; a native `disabled`
   * control gets no focus or pointer events and could never show it. Use `disabled` when no reason is
   * worth giving.
   */
  disabledReason?: ReactNode;
}

export interface CheckboxProps
  extends
    Omit<
      ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
      'asChild' | 'children' | 'checked' | 'defaultChecked' | 'onCheckedChange'
    >,
    DisabledReason {
  /** Controlled state. `'indeterminate'` is the dash for a parent of partly ticked children. */
  checked?: boolean | 'indeterminate';
  ref?: Ref<HTMLButtonElement>;
  defaultChecked?: boolean | 'indeterminate';
  onCheckedChange?: (checked: boolean) => void;
}

/** A checkbox (Figma Checkbox). Pair it with a `<label>`; pass `aria-label` when there is none. */
export function Checkbox({
  className,
  disabledReason,
  onClick,
  onCheckedChange,
  ...rest
}: CheckboxProps) {
  const blocked = disabledReason !== undefined && disabledReason !== null && disabledReason !== '';
  const control = (
    <CheckboxPrimitive.Root
      {...rest}
      className={join(styles.box, className)}
      {...(onCheckedChange
        ? {
            onCheckedChange: (next) => {
              if (!resetting) onCheckedChange(next === true);
            },
          }
        : {})}
      {...(blocked
        ? {
            'aria-disabled': true,
            onClick: (event: MouseEvent<HTMLButtonElement>) => {
              // Radix skips its toggle when a handler has prevented the default.
              event.preventDefault();
              onClick?.(event);
            },
          }
        : { onClick })}
    >
      <CheckboxPrimitive.Indicator className={styles.indicator}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          {rest.checked === 'indeterminate' || rest.defaultChecked === 'indeterminate' ? (
            <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          ) : (
            <path
              d="M2.5 6.25 5 8.75l4.5-5"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  return blocked ? <Tooltip content={disabledReason}>{control}</Tooltip> : control;
}

export type RadioGroupProps = ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root> & {
  /**
   * Makes the group's own box disappear from the layout (`display: contents`), so wrapping two
   * labels in it leaves their spacing alone. Keep only the radios of one choice (and nothing else that
   * can take focus) inside a group: Radix makes the group a tab stop that sends focus to the chosen
   * radio, so a button or field in between would be skipped, and Shift+Tab from it would bounce back.
   */
  neutral?: boolean;
};

/**
 * A group of radios. Give it `name` to submit the choice in a form, and `aria-label` or
 * `aria-labelledby` for the group name. Use `asChild` on a `<fieldset>` to keep its `<legend>`.
 */
export function RadioGroup({ onValueChange, neutral, className, ...rest }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive.Root
      {...rest}
      className={join(neutral && styles.neutral, className) || undefined}
      {...(onValueChange
        ? {
            onValueChange: (next: string) => {
              if (!resetting) onValueChange(next);
            },
          }
        : {})}
    />
  );
}

export interface RadioProps
  extends
    Omit<ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>, 'asChild' | 'children'>,
    DisabledReason {}

/** One radio inside a `RadioGroup`. Pair it with a `<label>` like `Checkbox`. */
export function Radio({ className, disabledReason, onClick, ...rest }: RadioProps) {
  const blocked = disabledReason !== undefined && disabledReason !== null && disabledReason !== '';
  const control = (
    <RadioGroupPrimitive.Item
      {...rest}
      className={join(styles.radio, className)}
      {...(blocked
        ? {
            'aria-disabled': true,
            onClick: (event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              onClick?.(event);
            },
          }
        : { onClick })}
    >
      <RadioGroupPrimitive.Indicator className={styles.indicator}>
        <span className={styles.dot} />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
  return blocked ? <Tooltip content={disabledReason}>{control}</Tooltip> : control;
}

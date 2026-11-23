'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  cloneElement,
  createContext,
  useContext,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import styles from './tooltip.module.css';

/** Delay before the first tooltip opens. Neighbours open instantly while one is already showing. */
export const TOOLTIP_OPEN_DELAY_MS = 300;

/** Gap between the trigger and the bubble, and the margin kept to the viewport edge. */
const TOOLTIP_OFFSET = 8;
const TOOLTIP_VIEWPORT_PADDING = 8;

const ProviderContext = createContext(false);

/**
 * Shares the open delay between tooltips: once one is showing, moving to a neighbour opens its tooltip
 * at once. Mount it once near the root. A `Tooltip` outside any provider wraps itself in one, so it
 * still works, it just does not share the warm-up with its neighbours.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <ProviderContext value={true}>
      <TooltipPrimitive.Provider delayDuration={TOOLTIP_OPEN_DELAY_MS} skipDelayDuration={400}>
        {children}
      </TooltipPrimitive.Provider>
    </ProviderContext>
  );
}

export interface TooltipProps extends Omit<HTMLAttributes<HTMLElement>, 'content' | 'children'> {
  /** Passed on to the child, so a Tooltip can sit directly inside another `asChild` trigger (a dialog or popover trigger). */
  ref?: Ref<HTMLButtonElement>;
  /** The hint. Short text; leave it out (or empty) to render the child with no tooltip. */
  content: ReactNode;
  /** Exactly one element that takes a ref and DOM props (a button, a link, a span). It receives the hover and focus handlers. */
  children: ReactElement;
  /** Preferred side; the bubble flips when there is no room. Default `top`. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Alignment along that side. Default `center`. */
  align?: 'start' | 'center' | 'end';
}

/**
 * The design-system hover hint. Use it instead of the `title` attribute, which the browser draws in its
 * own style, with no keyboard access and a long delay (lint blocks `title` on DOM elements).
 *
 * Opens on hover after a short delay and at once on keyboard focus; Escape closes it. The bubble is
 * linked to the trigger with `aria-describedby` while it is open, so a screen reader hears it. A trigger
 * that is blocked for now should use `aria-disabled="true"` and stay focusable: a native `disabled`
 * button gets no pointer or focus events, so it could never show its reason.
 *
 * The hint must never be the only place a control's name or an essential fact lives: touch screens have
 * no hover. An icon button still needs its own `aria-label`.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  ...triggerProps
}: TooltipProps) {
  const hasProvider = useContext(ProviderContext);
  if (content === null || content === undefined || content === false || content === '') {
    return cloneElement(children, triggerProps);
  }
  const tooltip = (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild {...triggerProps}>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className={styles.content}
          side={side}
          align={align}
          sideOffset={TOOLTIP_OFFSET}
          collisionPadding={TOOLTIP_VIEWPORT_PADDING}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? (
    tooltip
  ) : (
    <TooltipPrimitive.Provider delayDuration={TOOLTIP_OPEN_DELAY_MS} skipDelayDuration={400}>
      {tooltip}
    </TooltipPrimitive.Provider>
  );
}

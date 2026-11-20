'use client';

import { createContext, useContext } from 'react';

/** Gap between a dropdown trigger and its floating panel (Figma Dropdown 31:128). */
export const DROPDOWN_POPOVER_OFFSET = 8;

/** Minimum margin kept between a floating panel and the viewport edges. */
export const DROPDOWN_CONTAINER_PADDING = 8;

/**
 * The element a floating list (Select, MultiSelect, Combobox, SuggestInput, DatePicker, RowMenu)
 * should portal into. A modal dialog sets it to its own content: Radix makes everything outside
 * the dialog inert, so a list portalled to the body could be seen but not clicked. Outside a
 * dialog it is undefined and lists use the body.
 */
export const PopoverContainerContext = createContext<HTMLElement | undefined>(undefined);

export function usePopoverContainer(): HTMLElement | undefined {
  return useContext(PopoverContainerContext);
}

/**
 * Shared placement props for every React Aria Popover dropdown: anchored below the trigger,
 * 8 px gap, flips above only when there is no room below, 8 px viewport padding, and portalled
 * into the enclosing modal dialog when inside one.
 *
 * When portalled into a positioned dialog container, `position: 'absolute'` is set from frame 0
 * so React Aria's `getContainingBlock` resolves `offsetParent` immediately instead of running its
 * `position: fixed` fallback (which does not detect CSS `translate: -50% -50%` on Dialog content).
 */
export function dropdownPopoverProps(container: HTMLElement | undefined) {
  return {
    placement: 'bottom start' as const,
    offset: DROPDOWN_POPOVER_OFFSET,
    shouldFlip: true,
    containerPadding: DROPDOWN_CONTAINER_PADDING,
    ...(container
      ? {
          UNSTABLE_portalContainer: container,
          style: { position: 'absolute' as const },
        }
      : {}),
  };
}

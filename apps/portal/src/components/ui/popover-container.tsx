'use client';

import { createContext, useContext } from 'react';

/**
 * The element a floating list (Select, DatePicker) should portal into. A modal dialog sets it to
 * its own content: Radix makes everything outside the dialog inert, so a list portalled to the
 * body could be seen but not clicked. Outside a dialog it is undefined and lists use the body.
 */
export const PopoverContainerContext = createContext<HTMLElement | undefined>(undefined);

export function usePopoverContainer(): HTMLElement | undefined {
  return useContext(PopoverContainerContext);
}

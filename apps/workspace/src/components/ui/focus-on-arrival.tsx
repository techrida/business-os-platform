'use client';

import { useEffect } from 'react';

/**
 * Puts keyboard focus on the page's heading when the page opens, so a person who just confirmed
 * something and was sent here starts at the top of the new page instead of nowhere (focus is on
 * `<body>` after the page they were on is gone). It only moves focus when nothing has it, so it never
 * takes it from a control someone is already using. Renders nothing.
 */
export function FocusOnArrival() {
  useEffect(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const heading = document.querySelector<HTMLElement>('main h1');
    if (heading === null) return;
    // A heading is not focusable by default; -1 lets a script focus it without adding a tab stop.
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, []);
  return null;
}

'use client';

import { useEffect, useRef } from 'react';

/** The most trailing pinned columns that get their own sticky offset (table.module.css lists one rule each). */
const MAX_PINNED = 4;

/**
 * Gives a table's trailing pinned columns (cells marked `pinned`) their sticky offsets. CSS alone cannot know how
 * wide the columns after a pinned one are, so this measures the pinned header cells and writes the running widths
 * to `--table-pin-end-<n>` on the table's wrapper, the n-th pinned column from the end reading its own. Until it
 * has measured (server render, before hydration) only the last column is sticky, so nothing overlaps. It also
 * writes `--table-pin-total` (all pinned columns) and `--table-pin-last` (the last one, all that sticks on a phone)
 * to the wrapper, whose scroll padding keeps a focused cell from hiding behind the sticky band (WCAG 2.4.11).
 *
 * Renders a hidden span inside the wrapper and works from there, so the table itself stays a server component.
 */
export function PinnedColumnOffsets() {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const wrap = marker.current?.parentElement;
    const table = wrap?.querySelector('table');
    if (!wrap || !table) return;

    const pinnedHeaders = (): HTMLTableCellElement[] => {
      const cells = [...(table.tHead?.rows[0]?.cells ?? [])];
      const trailing: HTMLTableCellElement[] = [];
      for (let i = cells.length - 1; i >= 0; i -= 1) {
        const cell = cells[i];
        if (!cell?.hasAttribute('data-pinned') || trailing.length === MAX_PINNED) break;
        trailing.push(cell);
      }
      return trailing;
    };

    const measure = () => {
      const trailing = pinnedHeaders();
      let offset = 0;
      let last = 0;
      trailing.forEach((cell, index) => {
        wrap.style.setProperty(`--table-pin-end-${index + 1}`, `${offset}px`);
        const width = cell.getBoundingClientRect().width;
        if (index === 0) last = width;
        offset += width;
      });
      if (trailing.length > 0) {
        // The sticky band's width, so a focused cell scrolls clear of it (scroll-padding in table.module.css).
        wrap.style.setProperty('--table-pin-total', `${offset}px`);
        wrap.style.setProperty('--table-pin-last', `${last}px`);
        wrap.setAttribute('data-pinned-ready', '');
      } else {
        wrap.removeAttribute('data-pinned-ready');
      }
    };

    measure();
    // Browsers without ResizeObserver (and jsdom) keep the first measurement.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    for (const cell of pinnedHeaders()) observer.observe(cell);
    return () => observer.disconnect();
  }, []);

  return <span ref={marker} hidden />;
}

'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import styles from './field.module.css';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * The label of a `Field`, held to ONE line so that a long label never pushes its box below the box next to it
 * (UIP-FORM-010). A label wider than its row is cut with an ellipsis and its full text shows in a tooltip; the
 * `<label>` itself still carries the whole text, so the accessible name is unchanged. The clip is measured, not
 * assumed, so a label that fits has no tooltip.
 */
export function FieldLabel({
  id,
  htmlFor,
  children,
}: {
  id: string;
  htmlFor: string;
  children: ReactNode;
}) {
  const labelRef = useRef<HTMLLabelElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!label) return;
    const measure = () => setClipped(label.scrollWidth > label.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, [children]);
  return (
    <Tooltip content={clipped ? children : null}>
      <label ref={labelRef} id={id} htmlFor={htmlFor} className={styles.label}>
        {children}
      </label>
    </Tooltip>
  );
}

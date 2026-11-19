'use client';

import { useId, useState } from 'react';

import styles from './contents.module.css';

/** Text longer than this starts collapsed. A few short paragraphs read fine without a toggle. */
export const LONG_TEXT_COLLAPSE_AT = 200;

/**
 * Free text from a quotation (scope, assumptions): shown in full when short, otherwise clamped to
 * a few lines with a Show more / Show less button. The full text is always in the page, so
 * search-in-page and screen readers still find it; the button only changes the clamp. Line breaks
 * the author typed are kept.
 */
export function LongText({
  text,
  collapseAt = LONG_TEXT_COLLAPSE_AT,
}: {
  text: string;
  collapseAt?: number;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > collapseAt || text.split('\n').length > 3;
  const clamped = collapsible && !expanded;
  return (
    <div className={styles.longText}>
      <p id={id} className={clamped ? `${styles.prose} ${styles.clamped}` : styles.prose}>
        {text}
      </p>
      {collapsible ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

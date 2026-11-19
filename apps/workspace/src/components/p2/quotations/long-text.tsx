'use client';

import { useId, useState, type ReactNode } from 'react';

import styles from './contents.module.css';

/** Text longer than this starts collapsed. A few short paragraphs read fine without a toggle. */
export const LONG_TEXT_COLLAPSE_AT = 200;

/**
 * Free wording from a quotation (scope, assumptions, terms): shown in full when short, otherwise
 * clamped to a few lines with a Show more / Show less button. The full wording is always in the
 * page, so search-in-page and screen readers still find it; the button only changes the clamp.
 *
 * The wording is rich text (D31). The server draws it (`<RichText>`) and passes it as `children`,
 * so this client file pulls in no contract code; `text` is the same wording as plain words
 * (`richTextToPlain`), used only to decide whether it is long enough to collapse.
 */
export function LongText({
  text,
  children,
  collapseAt = LONG_TEXT_COLLAPSE_AT,
}: {
  text: string;
  children: ReactNode;
  collapseAt?: number;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > collapseAt || text.split('\n').length > 3;
  const clamped = collapsible && !expanded;
  return (
    <div className={styles.longText}>
      <div id={id} className={clamped ? `${styles.prose} ${styles.clamped}` : styles.prose}>
        {children}
      </div>
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

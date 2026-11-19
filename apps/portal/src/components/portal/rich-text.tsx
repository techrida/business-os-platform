import { richTextToHtml } from '@bos/contracts';

import styles from './rich-text.module.css';

/**
 * Wording written with the terms editor: paragraphs, bulleted and numbered lists, bold and italic.
 * Older wording saved as plain text comes out as escaped paragraphs.
 */
export function RichText({ value }: { value: string }) {
  // Safe: richTextToHtml rebuilds the markup from an allow-list (p, ul, ol, li, strong, em, br, no attributes) and escapes all text.
  return (
    <div className={styles.richText} dangerouslySetInnerHTML={{ __html: richTextToHtml(value) }} />
  );
}

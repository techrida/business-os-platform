import { richTextToHtml } from '@bos/contracts';

import styles from './rich-text.module.css';

/**
 * Terms wording drawn as paragraphs, bulleted and numbered lists, bold and italic (D31). Takes
 * stored wording of either kind: rich text, or plain text saved before the editor existed
 * (drawn as escaped paragraphs). Renders nothing for an empty value. Server-safe: no state.
 */
export function RichText({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string | undefined;
}) {
  const html = richTextToHtml(value);
  if (html === '') return null;
  return (
    <div
      className={[styles.prose, className].filter(Boolean).join(' ')}
      // Safe: richTextToHtml rebuilds the markup from an allow-list, so no script, link or attribute survives.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

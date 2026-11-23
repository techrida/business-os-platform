/**
 * The Business OS mark, drawn in one colour (`currentColor`): the sample logo the empty logo slots show. A rounded
 * square holding two stacked bars, the way the product's own icon is built. Decorative: the slot carries the text.
 */
export function BosMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="currentColor" strokeWidth="3" />
      <rect x="8" y="9" width="16" height="4" rx="2" fill="currentColor" />
      <rect x="8" y="19" width="10" height="4" rx="2" fill="currentColor" />
    </svg>
  );
}

import type { RefObject } from 'react';

import { Alert } from '@/components/ui/alert';

/**
 * What a refused action says, with the way forward: a link to the invoice that already exists for
 * the line, and a plain link to reload when the page is out of date. Takes focus through `summaryRef`
 * (see `useFocusOnProblem`), so a keyboard or screen reader user lands on it.
 */
export function ErrorSummary({
  error,
  reload,
  reloadHref,
  link,
  summaryRef,
}: {
  error: string | undefined;
  reload: boolean | undefined;
  reloadHref: string;
  /** Where the refusal says to go instead, such as the invoice already drafted for the line. */
  link?: { href: string; label: string } | undefined;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  if (!error) return null;
  const hasActions = link !== undefined || reload === true;
  return (
    <Alert
      ref={summaryRef}
      tabIndex={-1}
      tone="error"
      role="alert"
      actions={
        hasActions ? (
          <>
            {link !== undefined ? <a href={link.href}>{link.label}</a> : null}
            {reload === true ? <a href={reloadHref}>Reload the page</a> : null}
          </>
        ) : null
      }
    >
      {error}
    </Alert>
  );
}

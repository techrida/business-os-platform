import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';

import { describeQuoteFailure } from './failure';

/** The page when the quotation (or its opportunity) cannot be loaded: forbidden, or a retryable error. */
export function LoadFailure({
  err,
  title,
  retryHref,
}: {
  err: unknown;
  title: string;
  retryHref: string;
}) {
  const f = describeQuoteFailure(err, 'load');
  const forbidden = f.kind === 'forbidden';
  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Quotations', href: '/quotations' }, { label: title }]} />
      <PageHeader title={title} />
      <Alert
        tone="error"
        role="alert"
        title={forbidden ? 'You cannot open this' : 'This did not load'}
        actions={forbidden ? null : <a href={retryHref}>Try again</a>}
      >
        {f.message}
      </Alert>
    </Page>
  );
}

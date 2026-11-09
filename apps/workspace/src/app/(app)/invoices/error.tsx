'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';

/** Last-resort boundary for the invoice list: say what happened, offer a retry. */
export default function InvoicesError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Page width="narrow">
      <PageHeader title="Invoices" />
      <Alert
        tone="error"
        role="alert"
        title="The invoices did not open"
        actions={<Button onClick={reset}>Try again</Button>}
      >
        Something went wrong on our side. Nothing was changed. Try again in a moment.
      </Alert>
    </Page>
  );
}

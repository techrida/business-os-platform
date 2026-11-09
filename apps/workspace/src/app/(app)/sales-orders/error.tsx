'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';

/** Last-resort boundary for the sales orders list: say what happened, offer a retry. */
export default function SalesOrdersError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Page width="narrow">
      <PageHeader title="Sales orders" />
      <Alert
        tone="error"
        role="alert"
        title="The sales orders did not open"
        actions={<Button onClick={reset}>Try again</Button>}
      >
        Something went wrong on our side. Nothing was changed. Try again in a moment.
      </Alert>
    </Page>
  );
}

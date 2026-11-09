'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';

/** Last-resort boundary for the statement: say what happened, offer a retry. Nothing was changed. */
export default function CustomerStatementError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Page>
      <PageHeader title="Customer statement" />
      <Alert
        tone="error"
        role="alert"
        title="The statement did not open"
        actions={<Button onClick={reset}>Try again</Button>}
      >
        Something went wrong on our side. This page only reads, so nothing was changed. Try again in
        a moment.
      </Alert>
    </Page>
  );
}

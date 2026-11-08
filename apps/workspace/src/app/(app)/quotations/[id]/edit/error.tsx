'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';

/** Last-resort boundary for the builder page: say what happened, offer a retry. */
export default function EditQuotationError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Page width="narrow">
      <PageHeader title="Edit quotation" />
      <Alert
        tone="error"
        role="alert"
        title="The quotation builder did not open"
        actions={<Button onClick={reset}>Try again</Button>}
      >
        Something went wrong on our side. Nothing was saved. Try again in a moment.
      </Alert>
    </Page>
  );
}

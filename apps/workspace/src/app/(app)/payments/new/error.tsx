'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';

/** Last-resort boundary for the Record payment page: say what happened, offer a retry. */
export default function NewPaymentError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Page width="narrow">
      <PageHeader title="Record payment" />
      <Alert
        tone="error"
        role="alert"
        title="The payment form did not open"
        actions={<Button onClick={reset}>Try again</Button>}
      >
        Something went wrong on our side. Nothing was recorded. Try again in a moment.
      </Alert>
    </Page>
  );
}

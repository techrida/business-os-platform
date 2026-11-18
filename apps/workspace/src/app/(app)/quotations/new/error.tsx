'use client';

import { SessionUnavailableNotice } from '@/components/shell/session-unavailable-notice';
import { isSessionUnavailable } from '@/lib/session-unavailable';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';

/** Last-resort boundary for the builder page: say what happened, offer a retry. */
export default function NewQuotationError({ error, retry }: { error: unknown; retry: () => void }) {
  if (isSessionUnavailable(error)) return <SessionUnavailableNotice retry={retry} />;
  return (
    <Page width="narrow">
      <PageHeader title="New quotation" />
      <Alert
        tone="error"
        role="alert"
        title="The quotation builder did not open"
        actions={<Button onClick={retry}>Try again</Button>}
      >
        Something went wrong on our side. Nothing was saved. Try again in a moment.
      </Alert>
    </Page>
  );
}

'use client';
// The new-lead page's client half: LeadForm inside its duplicate hint (F1-Q54 a). The form tells this wrapper its
// primary number (E.164, or null while none is complete and valid) and the wrapper hands it to the hint, so the
// lookup follows whichever row is marked primary. The page itself is a server component and cannot pass a callback.
import { type ComponentProps, useState } from 'react';

import { LeadForm } from '@/components/p2/crm/lead-form';

import type { DuplicateFetcher } from '../_lib/use-duplicate-hint';
import { LeadDuplicateHint } from './duplicate-hint';

export function NewLeadForm({
  fetcher,
  delayMs,
  ...form
}: Omit<ComponentProps<typeof LeadForm>, 'onPrimaryPhoneChange'> & {
  /** Tests pass a fake lookup and a short pause; the page uses the BFF route and the default pause. */
  fetcher?: DuplicateFetcher | undefined;
  delayMs?: number | undefined;
}) {
  const [primaryPhone, setPrimaryPhone] = useState<string | null>(null);
  return (
    <LeadDuplicateHint phone={primaryPhone} fetcher={fetcher} delayMs={delayMs}>
      <LeadForm {...form} onPrimaryPhoneChange={setPrimaryPhone} />
    </LeadDuplicateHint>
  );
}

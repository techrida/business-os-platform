'use client';

import type { LeadOwnerOption } from '@bos/contracts';

import { OwnerField } from '@/components/p2/crm/owner-field';

import { updateLeadOwnerAction } from '../actions';

export interface LeadOwnerFieldProps {
  leadId: string;
  /** The lead's version as the page showed it; sent so a stale page gets a 409, not an overwrite. */
  version: number;
  ownerUserId: string | null;
  /** The owner's display name from the lead (D46); null without an owner. */
  ownerName: string | null;
  /** People the caller may hand the lead to (`GET /v1/leads/owners`). */
  owners: readonly LeadOwnerOption[];
}

/**
 * The value of the lead page's "Lead owner" fact (D38). Mount it as
 * `{ label: 'Lead owner', value: <LeadOwnerField ... /> }` in the overview facts.
 */
export function LeadOwnerField({ leadId, ...rest }: LeadOwnerFieldProps) {
  return (
    <OwnerField
      {...rest}
      recordId={leadId}
      idField="leadId"
      action={updateLeadOwnerAction}
      savedMessage={(name) => `Lead owner changed to ${name}.`}
    />
  );
}

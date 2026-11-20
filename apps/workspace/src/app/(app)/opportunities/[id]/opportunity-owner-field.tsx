'use client';

import type { LeadOwnerOption } from '@bos/contracts';
import { useRouter } from 'next/navigation';

import { OwnerField } from '@/components/p2/crm/owner-field';
import { toast } from '@/components/ui/toast';

import { updateOpportunityOwnerAction } from '../actions';

export interface OpportunityOwnerFieldProps {
  opportunityId: string;
  /** The deal's version as the page showed it; a stale page gets a 409, not an overwrite. */
  version: number;
  ownerUserId: string | null;
  ownerName: string | null;
  /** People the caller may hand the deal to (`GET /v1/opportunities/owners`). */
  owners: readonly LeadOwnerOption[];
}

/**
 * The opportunity page's "Owner" fact for people who may edit the deal (F1-Q51): the same control
 * as a lead's owner. The previous owner's open follow-ups move to the new owner (others' stay), so the
 * hint and the toast say so. A
 * hand-over that takes the deal out of the caller's reach returns them to the list.
 */
export function OpportunityOwnerField({ opportunityId, ...rest }: OpportunityOwnerFieldProps) {
  const router = useRouter();
  return (
    <OwnerField
      {...rest}
      recordId={opportunityId}
      idField="opportunityId"
      action={updateOpportunityOwnerAction}
      hint="The previous owner's open follow-ups move to the new owner."
      savedMessage={(name) =>
        `Owner changed to ${name}. The previous owner's open follow-ups moved to them.`
      }
      onHandedAway={(name) => {
        toast.success(`Handed to ${name}. The previous owner's open follow-ups moved to them.`);
        router.push('/opportunities');
      }}
    />
  );
}

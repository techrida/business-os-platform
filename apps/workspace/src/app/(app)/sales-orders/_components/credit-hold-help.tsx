'use client';

import Link from 'next/link';
import { useState } from 'react';

import { CreditOverrideDialog } from '@/app/(app)/opportunities/[id]/credit-override-dialog';

import type { ActionState } from '../_lib/state';
import styles from './sales-orders.module.css';

/**
 * What a person can do about a credit hold that stopped the confirm (F1-Q20). A `credit.override`
 * holder overrides it here, since Finance often cannot open the deal itself; anyone who can open
 * the deal gets a link to it. Someone who can do neither is left with the refusal's own words,
 * which say who can override, and no control that would be refused.
 *
 * The refusal is about the quotation version that was submitted. Once the form selects another
 * one (`selectedVersionId`), nothing is offered: an Override here would release the hold of a deal
 * that is no longer the one being confirmed. `quotationNumber` names that quotation in the override.
 */
export function CreditHoldHelp({
  hold,
  selectedVersionId,
  quotationNumber,
}: {
  hold: NonNullable<ActionState['creditHold']>;
  selectedVersionId: string;
  quotationNumber?: string | undefined;
}) {
  const [overridden, setOverridden] = useState<string | null>(null);
  const done = overridden === hold.opportunityId;
  if (hold.quotationVersionId !== selectedVersionId) return null;
  if (!hold.canOverride && !hold.canOpen) return null;
  return (
    <div className={styles.creditHold}>
      {done ? (
        <p role="status">Credit hold overridden. Choose Confirm order to try again.</p>
      ) : hold.canOverride ? (
        <CreditOverrideDialog
          opportunityId={hold.opportunityId}
          number={hold.number}
          quotation={quotationNumber}
          position={hold.position}
          successMessage="Credit hold overridden. Confirm the order again."
          onOverridden={() => setOverridden(hold.opportunityId)}
        />
      ) : null}
      {hold.canOpen ? (
        <Link href={`/opportunities/${hold.opportunityId}`}>
          {hold.number ? `Open ${hold.number}` : 'Open the opportunity'}
        </Link>
      ) : null}
    </div>
  );
}

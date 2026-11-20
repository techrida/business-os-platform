// Where the evidence of an accepted quotation version stands (F1-Q28). One rule, read by the evidence routes, the
// sales order's confirm gate and its detail, so none of them can disagree:
// - an acceptance staff recorded met `sales.evidence_policy` when it was recorded: confirmed at once;
// - a portal acceptance is recorded whatever the policy and stays pending until a staff member records the
//   evidence they hold (quotation_evidence_confirmations, migration 0107).
// The evidence the version stands on is the confirmation's kinds once there is one, else the acceptance's; its
// files are both rows' files.
import { type EvidenceKind, type EvidenceStatus } from '@bos/contracts';
import { quotationAcceptances, quotationEvidenceConfirmations, scoped } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import { type DbTransaction } from '../../../platform/db/db.module';
import { type TxScope } from '../../../platform/db/tx';

export type AcceptanceRow = typeof quotationAcceptances.$inferSelect;
export type EvidenceConfirmationRow = typeof quotationEvidenceConfirmations.$inferSelect;

export interface EvidenceState {
  acceptance: AcceptanceRow;
  confirmation: EvidenceConfirmationRow | null;
  status: EvidenceStatus;
  /** The kinds the version's evidence stands on now. */
  kinds: EvidenceKind[];
  /** The evidence files of the acceptance and the confirmation, distinct, in that order. */
  documentIds: string[];
}

/** The one rule: a staff entry, or a portal acceptance staff have confirmed. */
export function evidenceStatusOf(
  acceptance: Pick<AcceptanceRow, 'actorKind'>,
  confirmation: unknown,
): EvidenceStatus {
  return acceptance.actorKind === 'staff' || (confirmation !== null && confirmation !== undefined)
    ? 'confirmed'
    : 'pending';
}

export function evidenceStateOf(
  acceptance: AcceptanceRow,
  confirmation: EvidenceConfirmationRow | null,
): EvidenceState {
  return {
    acceptance,
    confirmation,
    status: evidenceStatusOf(acceptance, confirmation),
    kinds: [...(confirmation?.evidenceKinds ?? acceptance.evidenceKinds)],
    documentIds: [
      ...new Set([...acceptance.evidenceDocumentIds, ...(confirmation?.evidenceDocumentIds ?? [])]),
    ],
  };
}

/** The evidence of `versionId`'s acceptance in the acting entity; undefined when it has no accepted outcome. */
export async function readEvidenceState(
  tx: DbTransaction,
  scope: TxScope,
  versionId: string,
): Promise<EvidenceState | undefined> {
  const [acceptance] = await tx
    .select()
    .from(quotationAcceptances)
    .where(
      scoped(scope).where(
        quotationAcceptances,
        and(
          eq(quotationAcceptances.versionId, versionId),
          eq(quotationAcceptances.outcome, 'accepted'),
        ),
      ),
    );
  if (acceptance === undefined) return undefined;
  const [confirmation] = await tx
    .select()
    .from(quotationEvidenceConfirmations)
    .where(
      scoped(scope).where(
        quotationEvidenceConfirmations,
        eq(quotationEvidenceConfirmations.versionId, versionId),
      ),
    );
  return evidenceStateOf(acceptance, confirmation ?? null);
}

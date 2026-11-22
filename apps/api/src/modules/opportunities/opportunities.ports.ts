// The seam through which the quotations module learns that an opportunity was lost. Serves the NFR "no
// double effects": the handler runs inside the transaction that records the loss, so the opportunity and its
// open quotations change together or not at all. This unit defines the port; the quotation units implement it.
import type { Actor, DbTransaction, TxScope } from '../../platform/db/tx';

export interface OpportunityLostEvent {
  opportunityId: string;
  scope: TxScope;
  /** The user who marked the deal lost: the actor of every change the handler makes. */
  actor: Actor;
  reason: string;
  note: string;
}

export interface OpportunityLostHandler {
  /** A unique name, so a second registration of the same handler is caught when the module starts. */
  readonly name: string;
  /**
   * Called in the transaction that moved the opportunity to Lost, after the move. Throwing rolls the whole
   * move back, so a quotation that cannot be cancelled keeps the opportunity from being marked lost.
   */
  onLost(tx: DbTransaction, event: OpportunityLostEvent): Promise<void>;
}

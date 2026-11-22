// QuotationLostHandler: the quotations side of the opportunity Lost seam (OpportunityLostHandler). The module
// registers it with OpportunitiesService when it starts; until then the opportunity service's registry was empty in
// production and a lost deal left its quotations live. It runs in the transaction that marks the deal Lost, as the
// user who did it, and leaves every rule to CancelService.cancelOnLost. Which versions end, and why, is written there.
import { Injectable } from '@nestjs/common';

import type { DbTransaction } from '../../../platform/db/tx';
import type {
  OpportunityLostEvent,
  OpportunityLostHandler,
} from '../../opportunities/opportunities.ports';
import { CancelService } from '../drafting/cancel.service';

export const QUOTATION_LOST_HANDLER_NAME = 'quotations.cancel';

@Injectable()
export class QuotationLostHandler implements OpportunityLostHandler {
  readonly name = QUOTATION_LOST_HANDLER_NAME;

  constructor(private readonly cancellations: CancelService) {}

  async onLost(tx: DbTransaction, event: OpportunityLostEvent): Promise<void> {
    await this.cancellations.cancelOnLost(
      tx,
      event.scope,
      event.actor,
      event.opportunityId,
      event.reason,
    );
  }
}

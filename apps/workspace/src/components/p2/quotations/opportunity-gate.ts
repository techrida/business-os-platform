// Whether the quotation's opportunity lets Send and Accepted go through. Mirrors the API exactly:
// - Send (quotation-send.service.ts) calls OpportunitiesService.markQuotationSent, which leaves an
//   opportunity at Quotation sent or Negotiation as it is and otherwise needs a system edge to
//   Quotation sent (OPPORTUNITY_TRANSITIONS). From Won, Lost or On hold it refuses with 409.
// - Accepted (quotation-outcome.service.ts) calls markWon, which accepts an opportunity already Won
//   with this same version and otherwise needs a system edge to Won (from Quotation sent or
//   Negotiation).
// - Rejected moves no opportunity, so it is never blocked here.
// Pure, so the server page and the tests share it.
import { findTransition, type OpportunityDto, type OpportunityStage } from '@bos/contracts';

import { stageLabel } from '@/components/p2/crm/stages';

export type OpportunityFacts = Pick<OpportunityDto, 'stage' | 'wonQuotationVersionId'> &
  Partial<Pick<OpportunityDto, 'heldFromStage'>>;

function systemEdge(from: OpportunityStage, to: OpportunityStage): boolean {
  return findTransition('opportunity', from, to)?.by === 'system';
}

/** The API would accept the send's opportunity move. */
export function opportunityAllowsSend(opportunity: OpportunityFacts): boolean {
  const { stage } = opportunity;
  return (
    stage === 'quotation_sent' || stage === 'negotiation' || systemEdge(stage, 'quotation_sent')
  );
}

/** The API would accept the acceptance's opportunity move for this version. */
export function opportunityAllowsAccept(opportunity: OpportunityFacts, versionId: string): boolean {
  const { stage, wonQuotationVersionId } = opportunity;
  if (stage === 'won' && wonQuotationVersionId === versionId) return true;
  return systemEdge(stage, 'won');
}

/**
 * What to do about the opportunity, by stage: one plain sentence. A hold names the stage it resumes to only when
 * that stage was recorded (F1-Q53); an older hold just says Resume.
 */
function nextStep(stage: OpportunityStage, heldFromStage?: OpportunityStage | null): string {
  switch (stage) {
    case 'on_hold':
      return heldFromStage
        ? `Resume the opportunity to ${stageLabel('opportunity', heldFromStage)} first.`
        : 'Resume the opportunity first.';
    case 'lost':
      return 'A manager can reopen the opportunity first.';
    case 'won':
      return 'The opportunity is already won with another quotation.';
    default:
      return 'The opportunity has to reach Quotation sent or Negotiation first.';
  }
}

export interface OpportunityBlockers {
  /** Why Send is hidden, or null when the API would let it through. */
  send: string | null;
  /** Why Accepted is hidden, or null when the API would let it through. */
  accept: string | null;
}

const NONE: OpportunityBlockers = { send: null, accept: null };

/**
 * The reasons Send and Accepted are held back by the opportunity. An opportunity that could not be
 * read blocks nothing: the screen cannot know, and the API still decides.
 */
export function opportunityBlockers(
  opportunity: OpportunityFacts | null | undefined,
  versionId: string,
): OpportunityBlockers {
  if (opportunity == null) return NONE;
  const label = stageLabel('opportunity', opportunity.stage);
  return {
    send: opportunityAllowsSend(opportunity)
      ? null
      : `This quotation cannot be sent while its opportunity is ${label}. ${nextStep(opportunity.stage, opportunity.heldFromStage)}`,
    accept: opportunityAllowsAccept(opportunity, versionId)
      ? null
      : `This quotation cannot be recorded as accepted while its opportunity is ${label}. ${nextStep(opportunity.stage, opportunity.heldFromStage)}`,
  };
}

/** Why New quotation is not offered on a deal the caller may not quote on (R4a Q4 a). */
export const START_QUOTATION_REFUSED =
  "Only the deal's owner, their department or the person who created its lead can start a quotation.";

/**
 * The reason to show in place of New quotation, or null when nothing needs saying: the server's
 * `canDraftQuotation` allows it, or the deal is closed (no one starts a quotation on it). Omitted reads as no.
 */
export function startQuotationBlocker(
  opportunity: Pick<OpportunityDto, 'stage' | 'canDraftQuotation'>,
): string | null {
  if (opportunity.canDraftQuotation === true) return null;
  if (opportunity.stage === 'won' || opportunity.stage === 'lost') return null;
  return START_QUOTATION_REFUSED;
}

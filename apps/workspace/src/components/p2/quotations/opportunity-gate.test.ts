import { OPPORTUNITY_STAGES, type OpportunityStage } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  opportunityAllowsAccept,
  opportunityAllowsSend,
  opportunityBlockers,
} from './opportunity-gate';

const V = '22222222-2222-4222-8222-222222222222';
const OTHER = '22222222-2222-4222-8222-222222222223';

// What the API does, read from opportunities.service.ts (markQuotationSent, markWon) and the
// OPPORTUNITY_TRANSITIONS system edges, written out by hand so a change on either side shows here.
// The API's planner itself cannot be imported into this package's tests (it pulls in @bos/db).
const API_SENDS: Record<OpportunityStage, boolean> = {
  qualified: true,
  requirement_received: true,
  proposal_sent: true,
  quotation_sent: true,
  negotiation: true,
  won: false,
  lost: false,
  on_hold: false,
};
const API_ACCEPTS: Record<OpportunityStage, boolean> = {
  qualified: false,
  requirement_received: false,
  proposal_sent: false,
  quotation_sent: true,
  negotiation: true,
  won: false, // unless won with this same version, below
  lost: false,
  on_hold: false,
};

function apiSends(stage: OpportunityStage): boolean {
  return API_SENDS[stage];
}

function apiAccepts(stage: OpportunityStage, won: string | null): boolean {
  return (stage === 'won' && won === V) || API_ACCEPTS[stage];
}

describe('opportunity gate mirrors the API', () => {
  it.each(OPPORTUNITY_STAGES)('Send from %s', (stage) => {
    expect(opportunityAllowsSend({ stage, wonQuotationVersionId: null })).toBe(apiSends(stage));
  });

  it.each(OPPORTUNITY_STAGES)('Accepted from %s', (stage) => {
    for (const won of [null, V, OTHER]) {
      expect(opportunityAllowsAccept({ stage, wonQuotationVersionId: won }, V)).toBe(
        apiAccepts(stage, won),
      );
    }
  });

  it('holds back Send and Accepted on hold, with the next step in words', () => {
    const b = opportunityBlockers({ stage: 'on_hold', wonQuotationVersionId: null }, V);
    expect(b.send).toBe(
      'This quotation cannot be sent while its opportunity is On Hold. Move the opportunity back to Negotiation first.',
    );
    expect(b.accept).toBe(
      'This quotation cannot be recorded as accepted while its opportunity is On Hold. Move the opportunity back to Negotiation first.',
    );
  });

  it('holds back nothing in Negotiation, or when the opportunity could not be read', () => {
    expect(opportunityBlockers({ stage: 'negotiation', wonQuotationVersionId: null }, V)).toEqual({
      send: null,
      accept: null,
    });
    expect(opportunityBlockers(null, V)).toEqual({ send: null, accept: null });
  });
});

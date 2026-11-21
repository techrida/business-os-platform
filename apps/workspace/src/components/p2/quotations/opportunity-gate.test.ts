import { OPPORTUNITY_STAGES, type OpportunityStage } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  opportunityAllowsAccept,
  opportunityAllowsSend,
  opportunityBlockers,
  START_QUOTATION_REFUSED,
  startQuotationBlocker,
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

  it('holds back Send and Accepted on hold, naming the resume stage only when it was recorded', () => {
    const known = opportunityBlockers(
      { stage: 'on_hold', wonQuotationVersionId: null, heldFromStage: 'negotiation' },
      V,
    );
    expect(known.send).toBe(
      'This quotation cannot be sent while its opportunity is On Hold. Resume the opportunity to Negotiation first.',
    );
    expect(known.accept).toBe(
      'This quotation cannot be recorded as accepted while its opportunity is On Hold. Resume the opportunity to Negotiation first.',
    );
    // A hold from before F1-Q53 has no recorded stage: no stage is named.
    for (const heldFromStage of [null, undefined]) {
      const b = opportunityBlockers(
        { stage: 'on_hold', wonQuotationVersionId: null, heldFromStage },
        V,
      );
      expect(b.send).toBe(
        'This quotation cannot be sent while its opportunity is On Hold. Resume the opportunity first.',
      );
      expect(b.accept).toBe(
        'This quotation cannot be recorded as accepted while its opportunity is On Hold. Resume the opportunity first.',
      );
    }
  });

  it('holds back nothing in Negotiation, or when the opportunity could not be read', () => {
    expect(opportunityBlockers({ stage: 'negotiation', wonQuotationVersionId: null }, V)).toEqual({
      send: null,
      accept: null,
    });
    expect(opportunityBlockers(null, V)).toEqual({ send: null, accept: null });
  });
});

describe('startQuotationBlocker (R4a Q4 a)', () => {
  const open = OPPORTUNITY_STAGES.filter((stage) => stage !== 'won' && stage !== 'lost');

  it('says nothing when the server lets the caller start a quotation', () => {
    for (const stage of open) {
      expect(startQuotationBlocker({ stage, canDraftQuotation: true }), stage).toBeNull();
    }
  });

  it('gives the plain reason on an open deal the server refuses, or when the flag is missing', () => {
    for (const stage of open) {
      expect(startQuotationBlocker({ stage, canDraftQuotation: false }), stage).toBe(
        START_QUOTATION_REFUSED,
      );
      expect(startQuotationBlocker({ stage }), stage).toBe(START_QUOTATION_REFUSED);
    }
    expect(START_QUOTATION_REFUSED).not.toMatch(/accountant|finance|founder|sales|role/i);
  });

  it('says nothing on a closed deal: no one starts a quotation there', () => {
    for (const stage of ['won', 'lost'] as const) {
      expect(startQuotationBlocker({ stage, canDraftQuotation: false }), stage).toBeNull();
    }
  });
});

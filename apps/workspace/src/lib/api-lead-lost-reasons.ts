import 'server-only';

import {
  type CreateLeadLostReasonBody,
  type LeadLostReason,
  LeadLostReasonSchema,
  type ReorderLeadLostReasonsBody,
  type UpdateLeadLostReasonBody,
} from '@bos/contracts';
import { z } from 'zod';

import { call, seg } from './api-procurement';
import type { Session } from './session';

// The tenant's list of lost reasons (D49, D54-3). The Mark lost dialog reads the choices (crm.lead.write / crm.opportunity.write); the Settings card
// reads and changes the whole list (admin.settings.write, the Founder). Every call carries the staff session and every
// answer is parsed with the contracts' schemas.

const List = z.array(LeadLostReasonSchema);

const json = (method: 'POST' | 'PATCH' | 'PUT', body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** The options a person marking a lead lost can pick, in the list's order, without retired ones. */
export function listLeadLostReasonChoices(session: Session): Promise<LeadLostReason[]> {
  return call(session, '/v1/lead-lost-reasons', List);
}

/** The options a person marking an opportunity lost can pick, in the list's order, without retired ones. */
export function listOpportunityLostReasonChoices(session: Session): Promise<LeadLostReason[]> {
  return call(session, '/v1/opportunity-lost-reasons', List);
}

/** Every option, retired ones included, for the Settings card. */
export function listLeadLostReasons(session: Session): Promise<LeadLostReason[]> {
  return call(session, '/v1/admin/lead-lost-reasons', List);
}

/** Adds an option at the end of the list. 409 when its words are already an option. */
export function createLeadLostReason(
  session: Session,
  body: CreateLeadLostReasonBody,
): Promise<LeadLostReason> {
  return call(session, '/v1/admin/lead-lost-reasons', LeadLostReasonSchema, json('POST', body));
}

/** Renames and/or retires or restores one option. 409 for a stale version or a label already in use. */
export function updateLeadLostReason(
  session: Session,
  id: string,
  body: UpdateLeadLostReasonBody,
): Promise<LeadLostReason> {
  return call(
    session,
    `/v1/admin/lead-lost-reasons/${seg(id)}`,
    LeadLostReasonSchema,
    json('PATCH', body),
  );
}

/** Every option id in the new order; answers the whole list. */
export function reorderLeadLostReasons(
  session: Session,
  body: ReorderLeadLostReasonsBody,
): Promise<LeadLostReason[]> {
  return call(session, '/v1/admin/lead-lost-reasons/order', List, json('PUT', body));
}

/** Back to the seven defaults (D32); answers the whole list. */
export function resetLeadLostReasons(session: Session): Promise<LeadLostReason[]> {
  return call(session, '/v1/admin/lead-lost-reasons/reset', List, { method: 'POST' });
}

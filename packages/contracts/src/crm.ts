// Contracts for CRM: customers (tenant-level parties), contacts, KYB verification cases, leads,
// opportunities, activities and the website lead-ingest. Serves the NFR "the pipeline is auditable":
// stages move only along the transition table, Won is set by the system alone, and money is a string.
import { z } from 'zod';

import { DocumentVersionDtoSchema } from './documents.js';
import { CurrencySchema, DecimalString } from './money.js';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

/** A required, trimmed, bounded text field. */
const text = (max: number) => z.string().trim().min(1).max(max);

/** Money that cannot be negative (an expected value is never below zero). DecimalString allows a sign. */
const NonNegativeDecimal = DecimalString.refine((s) => !s.startsWith('-'), 'must not be negative');

const ProbabilitySchema = z.number().int().min(0).max(100);

/** E.164: a plus sign, then 7 to 15 digits. The server normalises before storing. */
export const PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 number such as +9779812345678');
export const EmailSchema = z.email().max(254);

// ---------------------------------------------------------------------------------------------
// Customers and contacts
// ---------------------------------------------------------------------------------------------

/** The most customers one GET /v1/customers page returns. The API rejects a larger `limit`; screens size their pickers by it. */
export const CUSTOMER_LIST_MAX_LIMIT = 100;

export const CUSTOMER_RELATIONSHIPS = ['prospect', 'active', 'inactive'] as const;
export const CustomerRelationshipSchema = z.enum(CUSTOMER_RELATIONSHIPS);
export type CustomerRelationship = z.infer<typeof CustomerRelationshipSchema>;

/**
 * A PAN or VAT number. Nepal's is 9 digits, but customers paid in INR or USD carry foreign tax ids,
 * so this only bounds the shape (letters, digits, hyphen) and leaves the Nepal check to the server.
 */
export const PanVatNoSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{5,20}$/, 'must be 5 to 20 letters, digits or hyphens');

export const AddressSchema = z.strictObject({
  line1: text(200),
  line2: text(200).optional(),
  city: text(100),
  district: text(100).optional(),
  province: text(100).optional(),
  postalCode: text(20).optional(),
  /** ISO 3166-1 alpha-2. */
  country: z.string().regex(/^[A-Z]{2}$/),
});
export type Address = z.infer<typeof AddressSchema>;

/**
 * The fields of a customer record. A customer is a tenant-level party (ADR 0027, D17): no
 * organizationId here. Terms that differ per legal entity live in `PartyAccountDtoSchema`. Lead
 * conversion and the edit form use these fields alone; `POST /v1/customers` adds the first contact.
 */
export const CustomerFieldsSchema = z.strictObject({
  legalName: text(200),
  panVatNo: PanVatNoSchema.optional(),
  industry: text(100).optional(),
  relationship: CustomerRelationshipSchema.default('prospect'),
  ownerUserId: z.guid().optional(),
  defaultCurrency: CurrencySchema.optional(),
  address: AddressSchema,
});
export type CustomerFields = z.infer<typeof CustomerFieldsSchema>;

/**
 * A contact that carries an email. A quotation is sent by email, so a customer must always have at
 * least one contact with an address: its first contact, and a contact created by lead conversion.
 */
export const ContactWithEmailBodySchema = z.strictObject({
  fullName: text(200),
  email: EmailSchema,
  phone: PhoneSchema.optional(),
  title: text(100).optional(),
  isPrimary: z.boolean().default(false),
});
export type ContactWithEmailBody = z.infer<typeof ContactWithEmailBodySchema>;

/**
 * `POST /v1/customers`: the customer and its first contact, created together (one transaction, so a
 * refusal leaves neither). The first contact needs an email and becomes the main contact.
 */
export const CreateCustomerBodySchema = CustomerFieldsSchema.extend({
  contact: ContactWithEmailBodySchema.omit({ isPrimary: true }),
  /**
   * F1-Q55: why this customer is created although a possible duplicate already exists ("Create anyway"). Optional
   * until the name, or the PAN/VAT number without spaces and hyphens, matches a live customer the caller can read;
   * then it is required (400, reason `duplicate_reason_required`) and written to the audit trail
   * (`customer.duplicate_override`, with the rules each match met).
   */
  duplicateOverrideReason: text(500).optional(),
});
export type CreateCustomerBody = z.infer<typeof CreateCustomerBodySchema>;

export const UpdateCustomerBodySchema = CustomerFieldsSchema.partial().extend({
  /** The row version the client saw; a different current version means 409. */
  expectedVersion: z.number().int().min(1),
});
export type UpdateCustomerBody = z.infer<typeof UpdateCustomerBodySchema>;

export const CustomerDtoSchema = z.object({
  /** The party id. */
  id: z.guid(),
  /** Display number, for example CUS-0001. */
  number: z.string().min(1).max(32),
  legalName: z.string(),
  panVatNo: PanVatNoSchema.nullable(),
  industry: z.string().nullable(),
  relationship: CustomerRelationshipSchema,
  ownerUserId: z.guid().nullable(),
  /**
   * U15a-Q3: the owner's display name (D46: a name only, "Unnamed user" without one, null without an owner). Sent
   * on the staff list (`GET /v1/customers`); absent elsewhere and for portal callers.
   */
  ownerName: z.string().nullable().optional(),
  defaultCurrency: CurrencySchema.nullable(),
  address: AddressSchema,
  /** The customer's logo (`app.customers.logo_document_id`); null or absent shows initials. */
  logoDocumentId: z.guid().nullable().optional(),
  /** Set when this record was merged into another; the target is the live one. */
  mergedIntoId: z.guid().nullable(),
  version: z.number().int().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type CustomerDto = z.infer<typeof CustomerDtoSchema>;

/** Per-legal-entity terms for a customer (the `party_accounts` row). */
export const PartyAccountDtoSchema = z.object({
  partyId: z.guid(),
  organizationId: z.guid(),
  /** The legal entity's display name; the caller acts for that entity, so it is theirs to see. */
  organizationName: z.string().nullable().optional(),
  paymentTermId: z.guid().nullable(),
  creditLimit: NonNegativeDecimal.nullable(),
  version: z.number().int().min(1),
});
export type PartyAccountDto = z.infer<typeof PartyAccountDtoSchema>;

/**
 * A credit limit in NPR (D22): at most two decimals, never negative, no sign. '0.00' is a real limit (it holds
 * every order); "no limit" is null, never zero.
 */
export const CreditLimitSchema = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'must be an NPR amount with at most two decimals, not negative');

/**
 * `PATCH /v1/customers/:id/terms`: the customer's terms with the ACTING entity (its `party_accounts` row, created
 * on the first save). Send only what changes; at least one of `paymentTermId` and `creditLimit` is required.
 * - `paymentTermId`: an active payment term of the tenant, or null to clear it. Needs customer.write on the record.
 * - `creditLimit`: NPR, or null for no limit. Needs `customers.credit_limit.write`; sent without it is a 403, never
 *   dropped.
 * - `expectedVersion`: the row's version the client saw. Required once the row exists (409 when stale or missing);
 *   leave it out on the first save (409 when the row was created in between). Answered with the PartyAccountDto.
 * - `organizationId`: the acting entity the form was rendered for (the detail's `actingEntity.organizationId`).
 *   When the caller now acts for another entity (switched in another tab), the save is 409 `conflict` with reason
 *   `entity_changed` and nothing is written, so a stale form never lands on another entity's terms.
 */
export const UpdateCustomerTermsBodySchema = z
  .strictObject({
    organizationId: z.guid(),
    paymentTermId: z.guid().nullable().optional(),
    creditLimit: CreditLimitSchema.nullable().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine((b) => b.paymentTermId !== undefined || b.creditLimit !== undefined, {
    message: 'at least one of paymentTermId and creditLimit is required',
  });
export type UpdateCustomerTermsBody = z.infer<typeof UpdateCustomerTermsBodySchema>;

/**
 * `POST /v1/customers/:id/contacts`. The email is optional here only because a later contact may
 * have none: the API refuses a contact without one while the customer has no contact with an email.
 */
export const CreateContactBodySchema = z.strictObject({
  fullName: text(200),
  email: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  title: text(100).optional(),
  isPrimary: z.boolean().default(false),
});
export type CreateContactBody = z.infer<typeof CreateContactBodySchema>;

export const ContactDtoSchema = z.object({
  id: z.guid(),
  customerId: z.guid(),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  isPrimary: z.boolean(),
  version: z.number().int().min(1),
});
export type ContactDto = z.infer<typeof ContactDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Stage catalogue and transitions (A2 section 2.2)
// ---------------------------------------------------------------------------------------------

/** "Engaged" and "Prospect" are not stages: Prospect is New, and Engaged was dropped (A2 C4). */
export const LEAD_STAGES = [
  'new',
  'contacted',
  'qualified',
  'converted',
  'lost',
  'on_hold',
] as const;
export const LeadStageSchema = z.enum(LEAD_STAGES);
export type LeadStage = z.infer<typeof LeadStageSchema>;

export const OPPORTUNITY_STAGES = [
  'qualified',
  'requirement_received',
  'proposal_sent',
  'quotation_sent',
  'negotiation',
  'won',
  'lost',
  'on_hold',
] as const;
export const OpportunityStageSchema = z.enum(OPPORTUNITY_STAGES);
export type OpportunityStage = z.infer<typeof OpportunityStageSchema>;

export const RECORD_KINDS = ['lead', 'opportunity'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export type StageDefinition = {
  recordKind: RecordKind;
  code: LeadStage | OpportunityStage;
  /** Position in the pipeline, from 1. */
  ordinal: number;
  label: string;
  /** No further moves, except a manager reopening a lost record. */
  isTerminal: boolean;
  /** Moving into this stage needs a reason and a note. */
  needsReason: boolean;
};

const LABELS: Record<LeadStage | OpportunityStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  converted: 'Converted',
  lost: 'Lost',
  on_hold: 'On Hold',
  requirement_received: 'Requirement Received',
  proposal_sent: 'Proposal Sent',
  quotation_sent: 'Quotation Sent',
  negotiation: 'Negotiation',
  won: 'Won',
};

const TERMINAL: readonly string[] = ['converted', 'won', 'lost'];
const NEEDS_REASON: readonly string[] = ['lost', 'on_hold'];

function catalogue(
  recordKind: RecordKind,
  stages: readonly (LeadStage | OpportunityStage)[],
): StageDefinition[] {
  return stages.map((code, i) => ({
    recordKind,
    code,
    ordinal: i + 1,
    label: LABELS[code],
    isTerminal: TERMINAL.includes(code),
    needsReason: NEEDS_REASON.includes(code),
  }));
}

/**
 * One catalogue for both record kinds. It is keyed by (recordKind, code): `qualified`, `lost` and
 * `on_hold` exist in both kinds, so the code alone is not unique. A constant, not a table.
 */
export const STAGE_CATALOGUE: readonly StageDefinition[] = [
  ...catalogue('lead', LEAD_STAGES),
  ...catalogue('opportunity', OPPORTUNITY_STAGES),
];

/** Who may make a move: any permitted user, a manager (reopen), or only the system (side effect of another action). */
export type TransitionActor = 'user' | 'manager' | 'system';

export type StageTransition<S extends string> = {
  from: S;
  to: S;
  by: TransitionActor;
  /** The move needs a reason and a note. */
  needsReason: boolean;
};

function edges<S extends string>(
  list: readonly (readonly [S, S] | readonly [S, S, TransitionActor])[],
): StageTransition<S>[] {
  return list.map(([from, to, by]) => ({
    from,
    to,
    by: by ?? 'user',
    needsReason: NEEDS_REASON.includes(to),
  }));
}

/**
 * The lead state machine, edge for edge (A2 section 2.2). Converted comes only from Qualified and is
 * its own action (`ConvertLeadBodySchema`), not a stage change.
 *
 * Resuming from On hold (F1-Q53): the table has an edge back to every stage a lead can be held at, but a
 * held lead takes only ONE of them, the stage it was held at (`heldFromStage`, see `resumeTarget`). A lead
 * held before that was recorded resumes to Contacted, as it always did.
 */
export const LEAD_TRANSITIONS: readonly StageTransition<LeadStage>[] = edges<LeadStage>([
  ['new', 'contacted'],
  ['contacted', 'qualified'],
  ['new', 'lost'],
  ['contacted', 'lost'],
  ['qualified', 'lost'],
  ['new', 'on_hold'],
  ['contacted', 'on_hold'],
  ['qualified', 'on_hold'],
  ['on_hold', 'new'],
  ['on_hold', 'contacted'],
  ['on_hold', 'qualified'],
  ['qualified', 'converted'],
  ['lost', 'contacted', 'manager'],
]);

/**
 * The opportunity state machine, edge for edge (A2 section 2.2). Won and Quotation Sent are side
 * effects of the quotation lifecycle, so only the system moves into them. A2's prose says forward
 * moves may skip optional stages, but its diagram draws no such edge; the diagram is encoded as is,
 * plus one addition: `qualified` to `quotation_sent` (system), so a quote can be sent from Qualified.
 */
export const OPPORTUNITY_TRANSITIONS: readonly StageTransition<OpportunityStage>[] =
  edges<OpportunityStage>([
    ['qualified', 'requirement_received'],
    ['qualified', 'quotation_sent', 'system'],
    ['requirement_received', 'proposal_sent'],
    ['requirement_received', 'quotation_sent', 'system'],
    ['proposal_sent', 'quotation_sent', 'system'],
    ['quotation_sent', 'negotiation'],
    ['negotiation', 'won', 'system'],
    ['quotation_sent', 'won', 'system'],
    ['qualified', 'lost'],
    ['requirement_received', 'lost'],
    ['proposal_sent', 'lost'],
    ['quotation_sent', 'lost'],
    ['negotiation', 'lost'],
    ['negotiation', 'on_hold'],
    ['on_hold', 'negotiation'],
    ['lost', 'qualified', 'manager'],
  ]);

/** Where a held record resumes when no held stage was recorded (a hold from before F1-Q53). */
export const LEGACY_RESUME_STAGE = { lead: 'contacted', opportunity: 'negotiation' } as const;

/**
 * The one stage a held record may resume to (F1-Q53): the stage it was held at, or the legacy fixed stage
 * when the hold predates that record. Every other `on_hold` edge is refused for this record.
 */
export function resumeTarget(kind: 'lead', heldFromStage: LeadStage | null): LeadStage;
export function resumeTarget(
  kind: 'opportunity',
  heldFromStage: OpportunityStage | null,
): OpportunityStage;
export function resumeTarget(kind: RecordKind, heldFromStage: string | null): string {
  return heldFromStage ?? LEGACY_RESUME_STAGE[kind];
}

/** The edge from one stage to another, or undefined when the machine has none. */
export function findTransition(
  kind: 'lead',
  from: LeadStage,
  to: LeadStage,
): StageTransition<LeadStage> | undefined;
export function findTransition(
  kind: 'opportunity',
  from: OpportunityStage,
  to: OpportunityStage,
): StageTransition<OpportunityStage> | undefined;
export function findTransition(
  kind: RecordKind,
  from: string,
  to: string,
): StageTransition<string> | undefined {
  const table: readonly StageTransition<string>[] =
    kind === 'lead' ? LEAD_TRANSITIONS : OPPORTUNITY_TRANSITIONS;
  return table.find((t) => t.from === from && t.to === to);
}

/**
 * The stages a user's stage-change request may name: every edge target that is not system-only. Lead
 * conversion is its own action, so `converted` is out; `won` and `quotation_sent` are system-only.
 */
const userTargets = <S extends string>(table: readonly StageTransition<S>[], skip: readonly S[]) =>
  [...new Set(table.filter((t) => t.by !== 'system' && !skip.includes(t.to)).map((t) => t.to))] as [
    S,
    ...S[],
  ];

export const LEAD_USER_STAGES = userTargets(LEAD_TRANSITIONS, ['converted']);
export const OPPORTUNITY_USER_STAGES = userTargets(OPPORTUNITY_TRANSITIONS, []);

/**
 * Lost reasons (D49): the tenant's list a lead is marked Lost with. A lead stores a reference to the option, never
 * the words, so renaming an option renames it on every lead; a retired option stays on the leads that use it and
 * is only hidden from the choices. The defaults are what a tenant has until it changes the list (D32).
 */
export const DEFAULT_LEAD_LOST_REASONS = [
  { key: 'price', label: 'Price' },
  { key: 'competitor', label: 'Chose a competitor' },
  { key: 'no_budget', label: 'No budget' },
  { key: 'no_response', label: 'No response' },
  { key: 'not_a_fit', label: 'Not a fit' },
  { key: 'timing', label: 'Timing' },
  { key: 'other', label: 'Other' },
] as const;

export const LEAD_LOST_REASON_LABEL_MAX = 60;
const LostReasonLabelSchema = text(LEAD_LOST_REASON_LABEL_MAX);

/** One option of the list. `isDefault` marks the seven the app ships (reset restores them). */
export const LeadLostReasonSchema = z.object({
  id: z.guid(),
  label: z.string(),
  position: z.number().int().min(0),
  isDefault: z.boolean(),
  retired: z.boolean(),
  version: z.number().int().min(1),
});
export type LeadLostReason = z.infer<typeof LeadLostReasonSchema>;

/** The reason on a lead: the option's current label, and whether it has since been retired. */
export const LeadLostReasonRefSchema = z.object({
  id: z.guid(),
  label: z.string(),
  retired: z.boolean(),
});
export type LeadLostReasonRef = z.infer<typeof LeadLostReasonRefSchema>;

/** `POST /v1/admin/lead-lost-reasons`: add an option at the end of the list. */
export const CreateLeadLostReasonBodySchema = z.strictObject({ label: LostReasonLabelSchema });
export type CreateLeadLostReasonBody = z.infer<typeof CreateLeadLostReasonBodySchema>;

/** `PATCH /v1/admin/lead-lost-reasons/:id`: rename and/or retire or restore. */
export const UpdateLeadLostReasonBodySchema = z
  .strictObject({
    label: LostReasonLabelSchema.optional(),
    retired: z.boolean().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine((b) => b.label !== undefined || b.retired !== undefined, 'nothing to change');
export type UpdateLeadLostReasonBody = z.infer<typeof UpdateLeadLostReasonBodySchema>;

/** `PUT /v1/admin/lead-lost-reasons/order`: every option id, in the new order. */
export const ReorderLeadLostReasonsBodySchema = z.strictObject({
  ids: z.array(z.guid()).min(1).max(200),
  /** The list's token as the client saw it (`lostReasonsToken`); a different current token means 409 (D54-4). */
  expectedOrder: z.string().min(1).max(32),
});
export type ReorderLeadLostReasonsBody = z.infer<typeof ReorderLeadLostReasonsBodySchema>;

/** `POST /v1/admin/lead-lost-reasons/reset`: back to the defaults, only if the list is still as the client saw it. */
export const ResetLeadLostReasonsBodySchema = z.strictObject({
  expectedOrder: z.string().min(1).max(32),
});
export type ResetLeadLostReasonsBody = z.infer<typeof ResetLeadLostReasonsBodySchema>;

/** The words of the 409 for a stale list; the workspace matches on them to offer a reload. */
export const LOST_REASONS_STALE_MESSAGE =
  'The list changed. Reload to see the latest list, then try again.';

/**
 * A short fingerprint of the list as a person sees it: every option's id, position, version and retired flag, in
 * list order. Reorder and Reset send the one the screen was built from; the API computes it again from the locked
 * rows and refuses (409) when they differ, so a stale view never overwrites someone else's change. Computed by the
 * same code in the browser-facing app and the API (a 53-bit string hash, not a security measure).
 */
export function lostReasonsToken(
  options: readonly { id: string; position: number; version: number; retired: boolean }[],
): string {
  const text = [...options]
    .sort((x, y) => x.position - y.position || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((o) => `${o.id}:${o.position}:${o.version}:${o.retired ? 1 : 0}`)
    .join('|');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** The kinds of contact activity logged when moving a new lead to contacted (D48). */
export const CONTACT_ACTIVITY_KINDS = ['call', 'email'] as const;
export const ContactActivityKindSchema = z.enum(CONTACT_ACTIVITY_KINDS);
export type ContactActivityKind = z.infer<typeof ContactActivityKindSchema>;

export const ContactActivityBodySchema = z.strictObject({
  kind: ContactActivityKindSchema,
  subject: text(200).optional(),
  body: text(10000),
});
export type ContactActivityBody = z.infer<typeof ContactActivityBodySchema>;

/**
 * A lead's stage change. Lost carries a reference to an option (`lostReasonId`) or a new option to add in the same
 * step (`newLostReason`), plus the required note; On Hold keeps its free-text `reason` and note. The server derives
 * the lead's stored reason text from the option.
 */
export const LeadStageChangeBodySchema = z
  .strictObject({
    stage: z.enum(LEAD_USER_STAGES),
    reason: text(200).optional(),
    lostReasonId: z.guid().optional(),
    newLostReason: LostReasonLabelSchema.optional(),
    note: text(2000).optional(),
    contactActivity: ContactActivityBodySchema.optional(),
    /** The row version the client saw; a different current version means 409. */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((body, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (body.contactActivity !== undefined && body.stage !== 'contacted') {
      issue('contactActivity', 'only for a move to contacted');
    }
    if (body.stage === 'lost') {
      if ((body.lostReasonId === undefined) === (body.newLostReason === undefined)) {
        issue('lostReasonId', 'choose a lost reason, or add a new one');
      }
      if (body.reason !== undefined) issue('reason', 'a lost reason is chosen from the list');
      if (body.note === undefined) issue('note', 'a note is required to move to lost');
      return;
    }
    if (body.lostReasonId !== undefined) issue('lostReasonId', 'only for a move to lost');
    if (body.newLostReason !== undefined) issue('newLostReason', 'only for a move to lost');
    if (body.stage === 'on_hold') {
      for (const field of ['reason', 'note'] as const) {
        if (body[field] === undefined) issue(field, `a ${field} is required to move to on_hold`);
      }
    }
  });
export type LeadStageChangeBody = z.infer<typeof LeadStageChangeBodySchema>;

/**
 * An opportunity's stage change. Lost works as it does for a lead (D49, D54-3): a reference to an option of the same
 * tenant list (`lostReasonId`) or a new option added in the same step (`newLostReason`), plus the required note.
 * On Hold keeps its free-text `reason` and note.
 */
export const OpportunityStageChangeBodySchema = z
  .strictObject({
    stage: z.enum(OPPORTUNITY_USER_STAGES),
    reason: text(200).optional(),
    lostReasonId: z.guid().optional(),
    newLostReason: LostReasonLabelSchema.optional(),
    note: text(2000).optional(),
    /** The row version the client saw; a different current version means 409. */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((body, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (body.stage === 'lost') {
      if ((body.lostReasonId === undefined) === (body.newLostReason === undefined)) {
        issue('lostReasonId', 'choose a lost reason, or add a new one');
      }
      if (body.reason !== undefined) issue('reason', 'a lost reason is chosen from the list');
      if (body.note === undefined) issue('note', 'a note is required to move to lost');
      return;
    }
    if (body.lostReasonId !== undefined) issue('lostReasonId', 'only for a move to lost');
    if (body.newLostReason !== undefined) issue('newLostReason', 'only for a move to lost');
    if (body.stage === 'on_hold') {
      for (const field of ['reason', 'note'] as const) {
        if (body[field] === undefined) issue(field, `a ${field} is required to move to on_hold`);
      }
    }
  });
export type OpportunityStageChangeBody = z.infer<typeof OpportunityStageChangeBodySchema>;

/** `POST /v1/opportunities/:id/credit-override` (F1-Q20/F1-Q26): why the deal may go ahead over the limit, and for which order value. */
export const CreditOverrideBodySchema = z.strictObject({
  reason: text(500),
  /**
   * The pending order's value (NPR, two decimals) the person saw when they gave the override. When sent, the API
   * refuses the override (409) if the order is worth something else by then, so an override never covers an order
   * nobody reviewed (R5 FU4). The workspace always sends it.
   */
  orderValue: z
    .string()
    .regex(/^d+.d{2}$/)
    .optional(),
});
export type CreditOverrideBody = z.infer<typeof CreditOverrideBodySchema>;

/**
 * A deal's credit position (F1-Q20/F1-Q26, Kuu R4a Q1b, R5 FU4), for holders of `credit.override`. Amounts are NPR
 * with two decimals (D22). `exposure` is what the customer owes the acting entity now: its open receivable debits
 * less its open credits (unapplied payments, credit notes), each at its own NPR rate. `uninvoiced` is what its
 * confirmed sales orders with the entity have not billed yet (an order without an issued tax invoice counts in full,
 * a part-billed one for the rest), so an order is never counted both here and in `exposure`. `orderValue` is the
 * gross NPR value (VAT included) of the deal's accepted quotation that has not become a confirmed sales order yet
 * ('0.00' when none). `held` is `exposureWithOrder > creditLimit`, where
 * `exposureWithOrder = exposure + uninvoiced + orderValue`; never held without a limit. The override, once given for
 * an order of some value (`override.orderValue`), lets the deal's accepted quotation become a sales order as long as
 * the order is not worth more than that; `overrideCovers` says whether it covers `orderValue` now.
 */
export const CreditHoldDtoSchema = z.object({
  opportunityId: z.guid(),
  customerId: z.guid(),
  currency: z.literal('NPR'),
  creditLimit: DecimalString.nullable(),
  exposure: z.string().regex(/^-?\d+\.\d{2}$/),
  uninvoiced: z.string().regex(/^\d+\.\d{2}$/),
  orderValue: z.string().regex(/^\d+\.\d{2}$/),
  exposureWithOrder: z.string().regex(/^-?\d+\.\d{2}$/),
  held: z.boolean(),
  override: z
    .object({
      reason: z.string(),
      byUserId: z.guid(),
      byName: z.string(),
      at: isoDateTime,
      /** The gross NPR value of the order it was given against; null for one given before that was kept. */
      orderValue: z
        .string()
        .regex(/^\d+\.\d{2}$/)
        .nullable(),
    })
    .nullable(),
  overrideCovers: z.boolean(),
});
export type CreditHoldDto = z.infer<typeof CreditHoldDtoSchema>;

/**
 * `PATCH /v1/opportunities/:id/owner` (F1-Q51): hand the deal to another person. The same assignment rule as a
 * lead's owner (D38/D50, the entity's stored rule for opportunities); the old owner's open follow-ups on the deal
 * move with it (D45).
 */
export const OpportunityOwnerChangeBodySchema = z.strictObject({
  ownerUserId: z.guid(),
  /** The row version the client saw; a different current version means 409. */
  expectedVersion: z.number().int().min(1),
});
export type OpportunityOwnerChangeBody = z.infer<typeof OpportunityOwnerChangeBodySchema>;

// ---------------------------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------------------------

export const LEAD_SOURCES = [
  'website',
  'referral',
  'cold_outreach',
  'event',
  'partner',
  'social',
  'walk_in',
  'campaign',
  'other',
] as const;
export const LeadSourceSchema = z.enum(LEAD_SOURCES);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

/** The kinds a person can plan for later: a note is something that already happened. */
export const SCHEDULABLE_ACTIVITY_KINDS = ['call', 'meeting', 'email'] as const;
export const SchedulableActivityKindSchema = z.enum(SCHEDULABLE_ACTIVITY_KINDS);
export type SchedulableActivityKind = z.infer<typeof SchedulableActivityKindSchema>;

/** A follow-up planned while creating the lead: becomes a planned activity of that kind (D39). */
export const LeadFollowUpSchema = z.strictObject({
  kind: SchedulableActivityKindSchema,
  dueAt: isoDateTime,
  /** Defaults to the lead owner. */
  assigneeUserId: z.guid().optional(),
  subject: text(200).optional(),
  body: text(10000).optional(),
});
export type LeadFollowUp = z.infer<typeof LeadFollowUpSchema>;

const LeadFieldsSchema = z.strictObject({
  title: text(200),
  source: LeadSourceSchema,
  campaign: text(100).optional(),
  ownerUserId: z.guid().optional(),
  /** Free text until conversion creates or links a customer. */
  companyName: text(200),
  contactName: text(200),
  email: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  requirement: text(5000).optional(),
  expectedValue: NonNegativeDecimal.optional(),
  currency: CurrencySchema.optional(),
  probability: ProbabilitySchema.optional(),
  expectedClose: isoDate.optional(),
  notes: text(5000).optional(),
});

/**
 * `followUp` plans the first follow-up. `nextFollowUpAt` is the pre-D39 spelling of the same thing, kept so old
 * callers still work: it plans a call named "Follow up". Send one or the other.
 */
export const CreateLeadBodySchema = LeadFieldsSchema.extend({
  currency: CurrencySchema.default('NPR'),
  followUp: LeadFollowUpSchema.optional(),
  nextFollowUpAt: isoDateTime.optional(),
}).refine((b) => b.followUp === undefined || b.nextFollowUpAt === undefined, {
  path: ['followUp'],
  message: 'Send followUp or nextFollowUpAt, not both',
});
export type CreateLeadBody = z.infer<typeof CreateLeadBodySchema>;

/** Follow-ups are activities, so an edit changes the lead's own fields (owner included), not the next follow-up. */
export const UpdateLeadBodySchema = LeadFieldsSchema.partial().extend({
  expectedVersion: z.number().int().min(1),
});
export type UpdateLeadBody = z.infer<typeof UpdateLeadBodySchema>;

/**
 * A person a lead (or its follow-up) can be handed to: `GET /v1/leads/owners`. The list holds only users the
 * caller may assign to, so a caller with `own` scope sees just themselves.
 */
export const LeadOwnerOptionSchema = z.object({
  userId: z.guid(),
  displayName: z.string(),
  email: z.string(),
  /** The person's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  avatarDocumentId: z.guid().nullable().optional(),
});
export type LeadOwnerOption = z.infer<typeof LeadOwnerOptionSchema>;

/** `GET /v1/activities?status=`: planned ones belong on a Follow-ups card, logged ones in History. */
export const ACTIVITY_STATUSES = ['planned', 'logged'] as const;
export const ActivityStatusSchema = z.enum(ACTIVITY_STATUSES);
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

export const LeadDtoSchema = z.object({
  id: z.guid(),
  /** Display number, for example LD-2026-0142. */
  number: z.string().min(1).max(32),
  title: z.string(),
  source: LeadSourceSchema,
  campaign: z.string().nullable(),
  ownerUserId: z.guid().nullable(),
  /** The owner's display name (D46): name only, joined under the lead's own read permission. */
  ownerName: z.string().nullable(),
  companyName: z.string(),
  contactName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  customerId: z.guid().nullable(),
  contactId: z.guid().nullable(),
  requirement: z.string().nullable(),
  expectedValue: DecimalString.nullable(),
  currency: CurrencySchema,
  probability: ProbabilitySchema.nullable(),
  expectedClose: isoDate.nullable(),
  nextFollowUpAt: isoDateTime.nullable(),
  stage: LeadStageSchema,
  stageReason: z.string().nullable(),
  /** The option a lost lead was closed with (D49), by its current label; null unless lost with an option. */
  lostReason: LeadLostReasonRefSchema.nullable(),
  stageNote: z.string().nullable(),
  convertedOpportunityId: z.guid().nullable(),
  /** On hold only (F1-Q53): the stage the lead was held at and will resume to; null for a hold older than that. */
  heldFromStage: LeadStageSchema.nullable().optional(),
  allowedMoves: z.array(LeadStageSchema).optional(),
  canEdit: z.boolean().optional(),
  version: z.number().int().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type LeadDto = z.infer<typeof LeadDtoSchema>;

const ConvertCustomerChoiceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('existing'), customerId: z.guid() }),
  z.strictObject({ mode: z.literal('create'), customer: CustomerFieldsSchema }),
]);
const ConvertContactChoiceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('existing'), contactId: z.guid() }),
  z.strictObject({ mode: z.literal('create'), contact: ContactWithEmailBodySchema }),
]);

/**
 * Convert a qualified lead into a customer, a contact and an opportunity. The server warns about
 * duplicates (normalised email, phone, organisation name); "create anyway" is `duplicateOverride`
 * and needs a reason. The contact is required and must have an email (a new one names it; an
 * existing one is checked by the API), so the opportunity's quotations can be sent.
 */
export const ConvertLeadBodySchema = z.strictObject({
  customer: ConvertCustomerChoiceSchema,
  contact: ConvertContactChoiceSchema,
  opportunityName: text(200),
  duplicateOverride: z.strictObject({ reason: text(500) }).optional(),
  expectedVersion: z.number().int().min(1),
});
export type ConvertLeadBody = z.infer<typeof ConvertLeadBodySchema>;

// ---------------------------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------------------------

/** New opportunities start at Qualified; the stage is not a field here. */
export const CreateOpportunityBodySchema = z.strictObject({
  name: text(200),
  customerId: z.guid(),
  contactId: z.guid().optional(),
  leadId: z.guid().optional(),
  ownerUserId: z.guid().optional(),
  value: NonNegativeDecimal.optional(),
  currency: CurrencySchema.default('NPR'),
  probability: ProbabilitySchema.optional(),
  expectedClose: isoDate.optional(),
});
export type CreateOpportunityBody = z.infer<typeof CreateOpportunityBodySchema>;

export const OpportunityDtoSchema = z.object({
  id: z.guid(),
  /** Display number, for example DEAL-2026-0095. */
  number: z.string().min(1).max(32),
  name: z.string(),
  customerId: z.guid(),
  contactId: z.guid().nullable(),
  leadId: z.guid().nullable(),
  ownerUserId: z.guid().nullable(),
  /** The owner's display name (D46). */
  ownerName: z.string().nullable(),
  stage: OpportunityStageSchema,
  stageReason: z.string().nullable(),
  /** The option a lost opportunity was closed with (D54-3), by its current label; null unless lost with an option. */
  lostReason: LeadLostReasonRefSchema.nullable(),
  stageNote: z.string().nullable(),
  value: DecimalString.nullable(),
  currency: CurrencySchema,
  probability: ProbabilitySchema.nullable(),
  expectedClose: isoDate.nullable(),
  /** Set by the system when a version is accepted. */
  wonQuotationVersionId: z.guid().nullable(),
  /** On hold only (F1-Q53): the stage the deal was held at and will resume to; null for a hold older than that. */
  heldFromStage: OpportunityStageSchema.nullable().optional(),
  allowedMoves: z.array(OpportunityStageSchema).optional(),
  canEdit: z.boolean().optional(),
  /**
   * The caller may create a quotation on this deal (FX-Q1, FX-Q2, R4a Q4 a): `quotation.draft`, and opportunity
   * read that reaches it as owner, through its department or as lead creator. Reading every deal does not count, and
   * neither does an assigned follow-up.
   */
  canDraftQuotation: z.boolean().optional(),
  /**
   * F1-Q20/F1-Q26, on the detail (`GET /v1/opportunities/:id`) only: whether the customer owes the acting entity more
   * than its credit limit, so an accepted quotation cannot become a sales order (409 `credit_hold`), whether someone
   * with `credit.override` overrode that, and whether the deal already has a confirmed or completed sales order
   * (`ordered`; then the hold no longer stands in its way). Amounts are on `GET /v1/opportunities/:id/credit-hold`
   * (credit.override).
   */
  creditHold: z
    .object({ held: z.boolean(), overridden: z.boolean(), ordered: z.boolean().optional() })
    .optional(),
  /**
   * R4a Q13, on the detail only: every stage change recorded since 0162, oldest first. `actorName` is the person who
   * made the move or set it off; null for a move with no user behind it (the system). Nothing before 0162 is kept.
   */
  stageHistory: z
    .array(
      z.object({
        from: OpportunityStageSchema,
        to: OpportunityStageSchema,
        at: isoDateTime,
        actorName: z.string().nullable(),
      }),
    )
    .optional(),
  version: z.number().int().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type OpportunityDto = z.infer<typeof OpportunityDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------------

/**
 * A2 section 2.1. `stage_change`, `system` and `collection_call` are written by the server, never posted by a user.
 * A `collection_call` is the call the payment-promise job plans for Finance after a missed promise (R4c1 Q1): it is
 * read and changed by the receivables permissions, not the customer's activity reach.
 */
export const ACTIVITY_KINDS = [
  'call',
  'meeting',
  'email',
  'note',
  'task',
  'stage_change',
  'system',
  'collection_call',
] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/**
 * What a person logs or plans (D39, D40). `task` is no longer one of them: a follow-up is a planned call, meeting
 * or email. The value stays in ACTIVITY_KINDS so rows written before D39 still read.
 */
export const USER_ACTIVITY_KINDS = ['call', 'meeting', 'email', 'note'] as const;
export const UserActivityKindSchema = z.enum(USER_ACTIVITY_KINDS);

/** An activity hangs off exactly one of these records. */
export const ACTIVITY_SUBJECT_KEYS = [
  'leadId',
  'opportunityId',
  'customerId',
  'contactId',
  'quotationId',
] as const;

const exactlyOneSubject = (
  a: Partial<Record<(typeof ACTIVITY_SUBJECT_KEYS)[number], string | null | undefined>>,
) => ACTIVITY_SUBJECT_KEYS.filter((k) => a[k] !== undefined && a[k] !== null).length === 1;
const ONE_SUBJECT = {
  path: ['leadId'],
  message: 'exactly one of leadId, opportunityId, customerId, contactId or quotationId is required',
};

export const CreateActivityBodySchema = z
  .strictObject({
    kind: UserActivityKindSchema,
    /** What the activity is about, as a line of text; not the record it belongs to. */
    subject: text(200),
    body: text(10000).optional(),
    dueAt: isoDateTime.optional(),
    assigneeUserId: z.guid().optional(),
    occurredAt: isoDateTime.optional(),
    leadId: z.guid().optional(),
    opportunityId: z.guid().optional(),
    customerId: z.guid().optional(),
    contactId: z.guid().optional(),
    quotationId: z.guid().optional(),
  })
  .refine(exactlyOneSubject, ONE_SUBJECT)
  .refine((a) => a.dueAt === undefined || a.kind !== 'note', {
    path: ['kind'],
    message: 'A note cannot be planned for later',
  })
  .refine((a) => a.dueAt === undefined || a.occurredAt === undefined, {
    path: ['occurredAt'],
    message: 'A planned activity has no occurred time until it is completed',
  });
export type CreateActivityBody = z.infer<typeof CreateActivityBodySchema>;

/**
 * What the caller may do with one activity, decided by the same rule the complete, reschedule and cancel routes
 * enforce. All false for an activity that is not planned or that the system wrote.
 */
export const ActivityCanSchema = z.object({
  complete: z.boolean(),
  reschedule: z.boolean(),
  cancel: z.boolean(),
});
export type ActivityCan = z.infer<typeof ActivityCanSchema>;

export const ActivityDtoSchema = z
  .object({
    id: z.guid(),
    kind: ActivityKindSchema,
    subject: z.string(),
    body: z.string().nullable(),
    leadId: z.guid().nullable(),
    opportunityId: z.guid().nullable(),
    customerId: z.guid().nullable(),
    contactId: z.guid().nullable(),
    quotationId: z.guid().nullable(),
    dueAt: isoDateTime.nullable(),
    assigneeUserId: z.guid().nullable(),
    /** The assignee's display name (D46): name only, joined under the subject's own read permission. */
    assigneeName: z.string().nullable(),
    completedAt: isoDateTime.nullable(),
    /** Set when a planned activity is cancelled. A cancelled one is neither planned nor in History. */
    cancelledAt: isoDateTime.nullable(),
    /** Derived: has a due time and is neither completed nor cancelled. Planned ones stay out of History. */
    planned: z.boolean(),
    /** Who logged or scheduled it; null for rows written before this was recorded. */
    createdByUserId: z.guid().nullable(),
    /** The author's display name (D46); null when `createdByUserId` is. */
    createdByName: z.string().nullable(),
    occurredAt: isoDateTime,
    version: z.number().int().min(1),
    /** Sent on list rows, for the caller. The write routes leave it out; treat its absence as no actions. */
    can: ActivityCanSchema.optional(),
  })
  .refine(exactlyOneSubject, ONE_SUBJECT);
export type ActivityDto = z.infer<typeof ActivityDtoSchema>;

/** Completing a planned activity turns it into a logged one: `occurredAt` becomes the completion time. */
export const CompleteActivityBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  /** Appended to the activity's details when it is completed. */
  note: text(10000).optional(),
  /** When it actually happened; defaults to now. */
  occurredAt: isoDateTime.optional(),
});
export type CompleteActivityBody = z.infer<typeof CompleteActivityBodySchema>;

export const RescheduleActivityBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  dueAt: isoDateTime,
  assigneeUserId: z.guid().optional(),
});
export type RescheduleActivityBody = z.infer<typeof RescheduleActivityBodySchema>;

export const CancelActivityBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type CancelActivityBody = z.infer<typeof CancelActivityBodySchema>;

// ---------------------------------------------------------------------------------------------
// Verification case (KYB). Tenant-level, like the party it verifies.
// ---------------------------------------------------------------------------------------------

export const VERIFICATION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'expired',
] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const CHECKLIST_ITEM_KEYS = [
  'registration_certificate',
  'pan_vat_certificate',
  'authorised_signatory_id',
  'address_proof',
  'other',
] as const;
/** The checklist of a vendor case (P4 K3): which party kind a case is for decides which keys it has. */
export const VENDOR_CHECKLIST_ITEM_KEYS = [
  'pan_certificate',
  'vat_certificate',
  'company_registration',
  'tax_clearance',
  'bank_proof',
  'proprietor_citizenship',
  'foreign_registration',
] as const;
export const VERIFICATION_PARTY_KINDS = ['customer', 'vendor'] as const;
export const VerificationPartyKindSchema = z.enum(VERIFICATION_PARTY_KINDS);
export type VerificationPartyKind = z.infer<typeof VerificationPartyKindSchema>;
export const ChecklistItemKeySchema = z.enum([
  ...CHECKLIST_ITEM_KEYS,
  ...VENDOR_CHECKLIST_ITEM_KEYS,
]);

export const CHECKLIST_ITEM_STATUSES = ['missing', 'provided', 'accepted', 'rejected'] as const;
export const ChecklistItemStatusSchema = z.enum(CHECKLIST_ITEM_STATUSES);

export const VerificationEvidenceSchema = z.object({
  documentId: z.guid(),
  documentVersionId: z.guid(),
  versionNumber: z.number().int().positive(),
  expiresOn: isoDate.nullable(),
});
export const VerificationReviewSchema = z.object({
  id: z.guid(),
  decision: z.enum(['approve', 'reject']),
  comment: z.string().nullable(),
  reviewedBy: z.guid(),
  reviewedAt: isoDateTime,
  round: z.number().int().nonnegative(),
  evidence: VerificationEvidenceSchema.nullable(),
});
export const ReviewVerificationItemBodySchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('approve'), expectedVersion: z.number().int().positive() }),
  z.strictObject({
    decision: z.literal('reject'),
    comment: z.string().trim().min(1).max(2000),
    expectedVersion: z.number().int().positive(),
  }),
]);
export type ReviewVerificationItemBody = z.infer<typeof ReviewVerificationItemBodySchema>;
export const VerificationVersionBodySchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});
export const VerificationReviewHistorySchema = z.object({
  items: z.array(
    VerificationReviewSchema.extend({
      reviewerName: z.string().nullable().optional(),
      /** The reviewer's picture (`app.users.avatar_document_id`); null or absent shows initials. */
      reviewerAvatarDocumentId: z.guid().nullable().optional(),
      itemKey: ChecklistItemKeySchema.nullable(),
      kind: z.enum(['item_decided', 'case_decided', 'legacy_case_decided']),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type VerificationReviewHistory = z.infer<typeof VerificationReviewHistorySchema>;

export const ChecklistItemSchema = z
  .object({
    key: ChecklistItemKeySchema,
    required: z.boolean(),
    status: ChecklistItemStatusSchema,
    /** The kernel document that backs the item; null exactly while the item is missing. */
    documentId: z.guid().nullable(),
    expiresOn: isoDate.nullable(),
    evidence: VerificationEvidenceSchema.nullable().optional(),
    review: VerificationReviewSchema.nullable().optional(),
  })
  .refine((i) => (i.status === 'missing') === (i.documentId === null), {
    path: ['documentId'],
    message: 'a document is present exactly when the item is not missing',
  });
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

/** A case can be approved only when it has a required item and every required item is accepted. */
export function isChecklistComplete(
  items: readonly Pick<ChecklistItem, 'required' | 'status'>[],
): boolean {
  const required = items.filter((i) => i.required);
  return required.length > 0 && required.every((i) => i.status === 'accepted');
}

/**
 * What the caller may do with one case, decided by the API on that case (the party's owner and the caller's scope),
 * so the case page never offers a control the API would refuse. The status rules (draft, submitted) stay the page's.
 */
export const VerificationCaseCanSchema = z.object({
  /** Review items and decide (verification.review on this case). */
  review: z.boolean(),
  /** Edit the checklist and submit (the party kind's write permission on this case). */
  edit: z.boolean(),
  /** Upload a file to this case (edit, plus documents.upload on it). */
  attach: z.boolean(),
  /** Take a file off the checklist (edit, plus verification.read on it). */
  remove: z.boolean(),
});
export type VerificationCaseCan = z.infer<typeof VerificationCaseCanSchema>;

export const VerificationCaseDtoSchema = z.object({
  partyKind: VerificationPartyKindSchema.optional(),
  /** Sent with a single case (GET /:id); absent in lists. */
  can: VerificationCaseCanSchema.optional(),
  /**
   * The party's display name and number (a customer's CUS number; vendors have none), joined under the case's own
   * read permission so the queue needs no customer or vendor read to label a case. Null when the party is gone.
   */
  partyName: z.string().nullable().optional(),
  partyNumber: z.string().nullable().optional(),
  reviewerNames: z.array(z.string()).optional(),
  looseEvidence: z.array(DocumentVersionDtoSchema).optional(),
  reviewPolicy: z.enum(['case_review_v0', 'document_review_v1']).optional(),
  approvalBlockedReason: z.string().nullable().optional(),
  reviewBlockedReason: z.string().nullable().optional(),
  reviewRound: z.number().int().nonnegative().optional(),
  submittedBy: z.guid().nullable().optional(),
  id: z.guid(),
  partyId: z.guid(),
  status: VerificationStatusSchema,
  checklist: z.array(ChecklistItemSchema),
  reviewedBy: z.guid().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  version: z.number().int().min(1),
});
export type VerificationCaseDto = z.infer<typeof VerificationCaseDtoSchema>;

export const AttachVerificationDocumentBodySchema = z.strictObject({
  key: ChecklistItemKeySchema,
  documentId: z.guid(),
  expiresOn: isoDate.optional(),
  expectedVersion: z.number().int().min(1),
});
export type AttachVerificationDocumentBody = z.infer<typeof AttachVerificationDocumentBodySchema>;

/** Removes the checklist association at the version the caller saw. */
export const RemoveVerificationDocumentBodySchema = AttachVerificationDocumentBodySchema.pick({
  key: true,
  expectedVersion: true,
});
export type RemoveVerificationDocumentBody = z.infer<typeof RemoveVerificationDocumentBodySchema>;

export const ReviewVerificationBodySchema = z
  .strictObject({
    decision: z.enum(['approve', 'reject']),
    comment: text(2000).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((body, ctx) => {
    if (body.decision === 'reject' && body.comment === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'a comment is required to reject',
      });
    }
  });
export type ReviewVerificationBody = z.infer<typeof ReviewVerificationBodySchema>;

// ---------------------------------------------------------------------------------------------
// Website lead-ingest (the contract only; the endpoint comes later). The input is untrusted.
// ---------------------------------------------------------------------------------------------

/**
 * What the public website posts. Strict and bounded: the website may not set the stage, owner,
 * probability, source or tenant; the server sets stage New and source `website`.
 */
export const LeadIngestBodySchema = z
  .strictObject({
    companyName: text(200),
    contactName: text(200),
    email: EmailSchema.optional(),
    phone: PhoneSchema.optional(),
    message: text(5000).optional(),
    /** UTM campaign, when the page carried one. */
    campaign: text(100).optional(),
    pageUrl: z.url().max(2048).optional(),
    /** The website's own id for this submission; a repeat with the same value is not a new lead. */
    externalRef: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional(),
  })
  .refine((b) => b.email !== undefined || b.phone !== undefined, {
    path: ['email'],
    message: 'an email or a phone number is required',
  });
export type LeadIngestBody = z.infer<typeof LeadIngestBodySchema>;

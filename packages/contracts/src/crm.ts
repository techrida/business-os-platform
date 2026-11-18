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
  defaultCurrency: CurrencySchema.nullable(),
  address: AddressSchema,
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
  paymentTermId: z.guid().nullable(),
  creditLimit: NonNegativeDecimal.nullable(),
  version: z.number().int().min(1),
});
export type PartyAccountDto = z.infer<typeof PartyAccountDtoSchema>;

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
  ['on_hold', 'contacted'],
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

function stageChangeBody<S extends string>(stages: [S, ...S[]]) {
  return z
    .strictObject({
      stage: z.enum(stages),
      reason: text(200).optional(),
      note: text(2000).optional(),
      /** The row version the client saw; a different current version means 409. */
      expectedVersion: z.number().int().min(1),
    })
    .superRefine((body, ctx) => {
      if (!NEEDS_REASON.includes(body.stage)) return;
      for (const field of ['reason', 'note'] as const) {
        if (body[field] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `a ${field} is required to move to ${body.stage}`,
          });
        }
      }
    });
}

export const LeadStageChangeBodySchema = stageChangeBody(LEAD_USER_STAGES);
export type LeadStageChangeBody = z.infer<typeof LeadStageChangeBodySchema>;

export const OpportunityStageChangeBodySchema = stageChangeBody(OPPORTUNITY_USER_STAGES);
export type OpportunityStageChangeBody = z.infer<typeof OpportunityStageChangeBodySchema>;

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

export const CreateLeadBodySchema = z.strictObject({
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
  currency: CurrencySchema.default('NPR'),
  probability: ProbabilitySchema.optional(),
  expectedClose: isoDate.optional(),
  nextFollowUpAt: isoDateTime.optional(),
  notes: text(5000).optional(),
});
export type CreateLeadBody = z.infer<typeof CreateLeadBodySchema>;

export const UpdateLeadBodySchema = CreateLeadBodySchema.partial().extend({
  expectedVersion: z.number().int().min(1),
});
export type UpdateLeadBody = z.infer<typeof UpdateLeadBodySchema>;

export const LeadDtoSchema = z.object({
  id: z.guid(),
  /** Display number, for example LD-2026-0142. */
  number: z.string().min(1).max(32),
  title: z.string(),
  source: LeadSourceSchema,
  campaign: z.string().nullable(),
  ownerUserId: z.guid().nullable(),
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
  stageNote: z.string().nullable(),
  convertedOpportunityId: z.guid().nullable(),
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
  stage: OpportunityStageSchema,
  stageReason: z.string().nullable(),
  stageNote: z.string().nullable(),
  value: DecimalString.nullable(),
  currency: CurrencySchema,
  probability: ProbabilitySchema.nullable(),
  expectedClose: isoDate.nullable(),
  /** Set by the system when a version is accepted. */
  wonQuotationVersionId: z.guid().nullable(),
  version: z.number().int().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type OpportunityDto = z.infer<typeof OpportunityDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------------

/** A2 section 2.1. `stage_change` and `system` are written by the server, never posted by a user. */
export const ACTIVITY_KINDS = [
  'call',
  'meeting',
  'email',
  'note',
  'task',
  'stage_change',
  'system',
] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const USER_ACTIVITY_KINDS = ['call', 'meeting', 'email', 'note', 'task'] as const;
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
  .refine(exactlyOneSubject, ONE_SUBJECT);
export type CreateActivityBody = z.infer<typeof CreateActivityBodySchema>;

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
    completedAt: isoDateTime.nullable(),
    occurredAt: isoDateTime,
  })
  .refine(exactlyOneSubject, ONE_SUBJECT);
export type ActivityDto = z.infer<typeof ActivityDtoSchema>;

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
export const ChecklistItemKeySchema = z.enum(CHECKLIST_ITEM_KEYS);

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

export const VerificationCaseDtoSchema = z.object({
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

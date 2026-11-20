// The evidence behind a quotation's acceptance, and the staff step that confirms it (F1-Q28, Kuu 2026-11-20: the
// customer accepts in the portal, then staff confirm the evidence: the signed copy, the purchase order).
//
// An acceptance staff recorded (`POST /v1/quotations/:id/versions/:vid/outcome`) met the evidence policy when it was
// recorded, so it is confirmed at once. A portal acceptance is recorded whatever the policy and waits for a staff
// member to confirm the evidence they hold (`POST .../evidence-confirmation`). A sales order of that version is
// confirmed only after that.
import { z } from 'zod';

import { ActorKindSchema, EVIDENCE_KINDS, EvidenceKindSchema } from './quotations.js';
import { EvidencePolicySchema } from './settings.js';

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

/** `pending` until staff confirm a portal acceptance's evidence; `confirmed` after, or at once for a staff entry. */
export const EVIDENCE_STATUSES = ['pending', 'confirmed'] as const;
export const EvidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

const evidenceKinds = z
  .array(EvidenceKindSchema)
  .min(1)
  .max(EVIDENCE_KINDS.length)
  .refine((kinds) => new Set(kinds).size === kinds.length, 'each evidence kind at most once');

/**
 * Body of `POST /v1/quotations/:id/versions/:vid/evidence-confirmation` (Idempotency-Key header). The kinds are the
 * evidence the staff member holds; they must meet `sales.evidence_policy` on their own. The files are kernel
 * documents uploaded first.
 */
export const ConfirmEvidenceBodySchema = z.strictObject({
  evidenceKinds,
  evidenceDocumentIds: z.array(z.guid()).max(20).default([]),
  comment: z.string().trim().min(1).max(2000).optional(),
});
export type ConfirmEvidenceBody = z.infer<typeof ConfirmEvidenceBodySchema>;

/**
 * `GET /v1/quotations/:id/versions/:vid/evidence` (and the answer to the confirmation): where the evidence of an
 * accepted version stands.
 */
export const QuotationEvidenceDtoSchema = z.object({
  quotationId: z.guid(),
  versionId: z.guid(),
  status: EvidenceStatusSchema,
  /** The entity's `sales.evidence_policy` now. */
  policy: EvidencePolicySchema,
  /** What the policy asks for that the evidence lacks: the confirmed kinds once confirmed, else the acceptance's. */
  missing: z.array(EvidenceKindSchema),
  acceptance: z.object({
    actorKind: ActorKindSchema,
    decidedOn: isoDate,
    acceptedByName: z.string().nullable(),
    evidenceKinds: z.array(EvidenceKindSchema),
    evidenceDocumentIds: z.array(z.guid()),
  }),
  /** The staff confirmation of a portal acceptance; null while pending and for a staff entry (confirmed by it). */
  confirmation: z
    .object({
      evidenceKinds: z.array(EvidenceKindSchema),
      evidenceDocumentIds: z.array(z.guid()),
      comment: z.string().nullable(),
      confirmedBy: z.guid(),
      confirmedAt: isoDateTime,
    })
    .nullable(),
  /** The caller may confirm now: pending, and `quotation.record_acceptance` on this quotation. */
  can: z.object({ confirm: z.boolean() }),
});
export type QuotationEvidenceDto = z.infer<typeof QuotationEvidenceDtoSchema>;

// Contracts for the approval engine: the workflow spec (what an admin publishes), the route plan
// (what a request will do) and the DTOs the inbox shows. Serves the NFR "approvals are auditable":
// a published spec is frozen, and every action carries a version so stale clicks are refused.
import { z } from 'zod';

import { RoleKeySchema } from './authz.js';
import { DecimalString } from './money.js';
import { decimalPattern, MONEY_LIMITS } from './number-limits.js';

const isoDateTime = z.iso.datetime({ offset: true });

const CONDITION_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { field: string; op: ConditionOp; value: string | number | boolean | string[] };

/**
 * A rule's `when`. Recursive: all/any nest. Empty all/any are rejected because `all: []` is
 * vacuously true, which would make a rule fire on every request. Decimal strings are compared with
 * decimal.js by the engine, not here.
 */
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z
      .strictObject({
        field: z.string().min(1),
        op: z.enum(CONDITION_OPS),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      })
      .refine((leaf) => (leaf.op === 'in') === Array.isArray(leaf.value), {
        path: ['value'],
        message: 'value must be a list exactly when op is "in"',
      }),
  ]),
);

/**
 * `department_head` (P4 K1, M8): the head of the department in the request's `departmentId` fact
 * approves. When there is no head, or the head is in the request's sodUserIds (the requester), the
 * step goes to `fallbackRole` instead (AD11). The router resolves this when it plans the step.
 */
export const StepKindSchema = z.enum(['role', 'group', 'user', 'department_head']);
export type StepKind = z.infer<typeof StepKindSchema>;

/** The role a department-head step falls back to when it is not set (AD11). */
export const DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE = 'operations_head' as const;

/**
 * One approval step. The field named by `kind` (role, group or user) must be present; a
 * department_head step names no target, only its `fallbackRole`.
 */
export const StepSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: StepKindSchema,
    role: RoleKeySchema.optional(),
    group: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    /** department_head only: who approves when the head cannot. Defaulted to operations_head below. */
    fallbackRole: RoleKeySchema.optional(),
    /** Shown to the approver and kept in the audit trail: why this step exists. */
    reason: z.string().min(1).max(500),
  })
  .refine((s) => s.kind === 'department_head' || s[s.kind] !== undefined, {
    path: ['kind'],
    message: 'the field named by kind (role, group or user) is required',
  })
  .refine((s) => s.kind === 'department_head' || s.fallbackRole === undefined, {
    path: ['fallbackRole'],
    message: 'fallbackRole applies to department_head steps only',
  })
  .transform((s) =>
    s.kind === 'department_head' && s.fallbackRole === undefined
      ? { ...s, fallbackRole: DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE }
      : s,
  );
export type StepSpec = z.infer<typeof StepSpecSchema>;

/** Reminder and escalation timing. Defaults sit on each field because a Zod 4 object default skips them. */
export const SlaSpecSchema = z
  .object({
    remindAfterHours: z.number().int().positive().default(24),
    escalateAfterHours: z.number().int().positive().default(72),
    /** The plan names no default role; founder is the one role every tenant has. */
    escalateTo: z.object({ role: RoleKeySchema }).prefault({ role: 'founder' }),
  })
  .refine((s) => s.escalateAfterHours > s.remindAfterHours, {
    path: ['escalateAfterHours'],
    message: 'must be later than remindAfterHours',
  });
export type SlaSpec = z.infer<typeof SlaSpecSchema>;

export const WorkflowRuleSchema = z.object({
  id: z.string().min(1).max(64),
  when: ConditionSchema,
  add: StepSpecSchema,
  position: z
    .union([z.literal('end'), z.strictObject({ after: z.string().min(1) })])
    .default('end'),
  reason: z.string().min(1).max(500),
});
export type WorkflowRule = z.infer<typeof WorkflowRuleSchema>;

export const WorkflowSpecSchema = z
  .object({
    documentType: z.string().min(1).max(64),
    steps: z.array(StepSpecSchema),
    rules: z.array(WorkflowRuleSchema).default([]),
    /** One person may not approve two steps of the same request. */
    distinctApprovers: z.boolean().default(true),
    sla: SlaSpecSchema.prefault({}),
  })
  .superRefine((spec, ctx) => {
    const ids = [...spec.steps.map((s) => s.id), ...spec.rules.map((r) => r.add.id)];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `duplicate step id "${id}"` });
      seen.add(id);
    }
    spec.rules.forEach((rule, i) => {
      if (rule.position !== 'end' && !seen.has(rule.position.after)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'position'],
          message: `unknown step id "${rule.position.after}"`,
        });
      }
    });
  });
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

/** A workflow amount threshold in NPR: at most 2 decimals and never signed, since a document amount is never below 0. */
export const WorkflowAmountString = z.string().regex(decimalPattern(MONEY_LIMITS));

export const WORKFLOW_AMOUNT_ERROR = 'Enter an amount with up to two decimal places.';
export const WORKFLOW_AMOUNT_NEGATIVE_ERROR = 'Enter an amount of zero or more.';

/** The message for a threshold value the write schema refuses, or null when it is accepted. */
export function workflowAmountIssue(value: unknown): string | null {
  if (WorkflowAmountString.safeParse(value).success) return null;
  return typeof value === 'string' && value.trim().startsWith('-')
    ? WORKFLOW_AMOUNT_NEGATIVE_ERROR
    : WORKFLOW_AMOUNT_ERROR;
}

/** Published versions retain their original rules. Validate new, edited and newly published specs. */
export const WorkflowWriteSpecSchema = WorkflowSpecSchema.superRefine((spec, ctx) => {
  function checkAmount(condition: Condition, path: (string | number)[]): void {
    if ('all' in condition) {
      condition.all.forEach((child, i) => checkAmount(child, [...path, 'all', i]));
    } else if ('any' in condition) {
      condition.any.forEach((child, i) => checkAmount(child, [...path, 'any', i]));
    } else if (condition.field === 'amountNpr') {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      const message = values.map(workflowAmountIssue).find((issue) => issue !== null);
      if (message) ctx.addIssue({ code: 'custom', path: [...path, 'value'], message });
    }
  }

  spec.rules.forEach((rule, i) => checkAmount(rule.when, ['rules', i, 'when']));
});

export const RoutePlanSchema = z.object({
  steps: z.array(
    z.object({
      seq: z.number().int().min(1),
      kind: StepKindSchema,
      roleKey: RoleKeySchema.optional(),
      groupId: z.string().optional(),
      userId: z.string().optional(),
      reason: z.string(),
      eligibleUserIds: z.array(z.string()),
      /** True when no eligible approver is left after separation of duties. */
      blocked: z.boolean(),
    }),
  ),
  blocked: z.boolean(),
  blockReason: z.string().optional(),
});
export type RoutePlan = z.infer<typeof RoutePlanSchema>;

/**
 * POST /v1/admin/workflows/:key/versions/:v/publish. `reason` is for the small-team rule (F1-Q11 a): a Founder who
 * saved the draft may publish it alone only when nobody else may publish, and must say why. Blank is accepted here
 * and refused by the API as `sole_eligible_reason_required`, so the client hears the specific reason.
 */
export const PublishWorkflowVersionBodySchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
});
export type PublishWorkflowVersionBody = z.infer<typeof PublishWorkflowVersionBodySchema>;

export const ApprovalActionBodySchema = z
  .object({
    action: z.enum(['approve', 'return', 'reject']),
    comment: z.string().trim().min(1).max(2000).optional(),
    /** The request version the client saw; a different current version means 409. */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((body, ctx) => {
    if (body.action !== 'approve' && body.comment === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'a comment is required to return or reject',
      });
    }
  });
export type ApprovalActionBody = z.infer<typeof ApprovalActionBodySchema>;

// DTOs below: where section 6.1 gives no fields, they follow the approval_* columns of section 4.

export const ApprovalStepStatusSchema = z.enum([
  'waiting',
  'active',
  'approved',
  'returned',
  'rejected',
  'skipped',
]);
export const ApprovalRequestStatusSchema = z.enum([
  'pending',
  'approved',
  'returned',
  'rejected',
  'blocked',
  'cancelled',
]);
export const ApprovalActionKindSchema = z.enum([
  'submit',
  'approve',
  'return',
  'reject',
  'escalate',
  'remind',
  'block',
  'reroute',
  /** A module withdrew the request (e.g. its quotation was revised); not an approver decision. */
  'cancel',
]);

/**
 * A person a record refers to, by display name. Records return the names of the people they name, so a reader
 * who may see the record needs no admin directory to label them.
 */
export const PersonNameSchema = z.object({
  userId: z.string(),
  name: z.string().min(1),
  /** The person's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  avatarDocumentId: z.guid().nullable().optional(),
});
export type PersonName = z.infer<typeof PersonNameSchema>;

/**
 * A record the frozen snapshot of an approval refers to by id (a vendor, a purchase order, a bill), by the name or
 * number its own page shows. Sent with the request so an approver needs no directory read to label it.
 */
export const ReferenceNameSchema = z.object({ id: z.string(), name: z.string().min(1) });
export type ReferenceName = z.infer<typeof ReferenceNameSchema>;

/**
 * One fact of the record an approval is about, as it stands now (not as submitted). `money` holds a decimal in
 * `currency`, `date` an ISO date or instant, `status` the record's raw status key; `text` is shown as it is.
 */
export const ApprovalContextFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  kind: z.enum(['text', 'money', 'date', 'status']),
  currency: z.string().optional(),
});
export type ApprovalContextField = z.infer<typeof ApprovalContextFieldSchema>;

/** A file of the record that this reader may open: the newest version of the document, and only when it is clean. */
export const ApprovalContextDocumentSchema = z.object({
  documentId: z.string(),
  versionId: z.string(),
  filename: z.string(),
  detectedMime: z.string().nullable(),
  /** That version's size, its uploader (null for a system or portal upload) and when it was uploaded. */
  sizeBytes: z.number().int().nonnegative().optional(),
  uploadedBy: z.guid().nullable().optional(),
  uploadedAt: isoDateTime.optional(),
});
export type ApprovalContextDocument = z.infer<typeof ApprovalContextDocumentSchema>;

/**
 * A read-only view of the record an approval is about, for anyone who may read the approval request (its approvers
 * included), so they can judge it without a read grant on the record itself. Main fields and the record's own files
 * only. `href` is the record's own page, and is null when this reader could not open it.
 */
export const ApprovalContextSchema = z.object({
  title: z.string(),
  fields: z.array(ApprovalContextFieldSchema),
  documents: z.array(ApprovalContextDocumentSchema),
  href: z.string().nullable(),
});
export type ApprovalContext = z.infer<typeof ApprovalContextSchema>;

export const ApprovalStepDtoSchema = z.object({
  seq: z.number().int().min(1),
  kind: StepKindSchema,
  roleKey: RoleKeySchema.nullable(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable().optional(),
  userId: z.string().nullable(),
  reason: z.string(),
  status: ApprovalStepStatusSchema,
  activatedAt: isoDateTime.nullable(),
  decidedBy: z.string().nullable(),
  decidedOnBehalfOf: z.string().nullable(),
  /**
   * The one person the author named to decide this step, when they named one (only the first step of some
   * document types). Then only they, or their delegate, see and decide it. Absent or null: anyone eligible.
   */
  assigneeUserId: z.string().nullable().optional(),
});
export type ApprovalStepDto = z.infer<typeof ApprovalStepDtoSchema>;

export const ApprovalActionDtoSchema = z.object({
  action: ApprovalActionKindSchema,
  actorUserId: z.string(),
  onBehalfOfUserId: z.string().nullable(),
  comment: z.string().nullable(),
  createdAt: isoDateTime,
});
export type ApprovalActionDto = z.infer<typeof ApprovalActionDtoSchema>;

export const ApprovalRequestDtoSchema = z.object({
  requestId: z.string(),
  documentType: z.string(),
  documentId: z.string(),
  documentNumber: z.string(),
  status: ApprovalRequestStatusSchema,
  blockReason: z.string().nullable(),
  currentSeq: z.number().int(),
  version: z.number().int(),
  requesterUserId: z.string(),
  /** Frozen copy of the document at submission; what the approvers actually saw. */
  snapshot: z.unknown(),
  steps: z.array(ApprovalStepDtoSchema),
  actions: z.array(ApprovalActionDtoSchema),
  people: z.array(PersonNameSchema).optional(),
  /** Names of the records the snapshot refers to by id, when its document type can name them. */
  references: z.array(ReferenceNameSchema).optional(),
  /** The record as it stands now, when its document type can describe it (see ApprovalContextSchema). */
  context: ApprovalContextSchema.optional(),
  submittedAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
});
export type ApprovalRequestDto = z.infer<typeof ApprovalRequestDtoSchema>;

export const InboxItemDtoSchema = z.object({
  requestId: z.string(),
  documentType: z.string(),
  documentId: z.string(),
  documentNumber: z.string(),
  title: z.string(),
  /** Null when the document has no NPR amount. */
  amountNpr: DecimalString.nullable(),
  /** Why this item is in the approver's inbox (the active step's reason). */
  reason: z.string(),
  activeStep: ApprovalStepDtoSchema,
  submittedAt: isoDateTime,
  version: z.number().int(),
});
export type InboxItemDto = z.infer<typeof InboxItemDtoSchema>;

export const InboxSummarySchema = z.array(
  z.object({
    documentType: z.string(),
    state: z.literal('pending'),
    age: z.enum(['under_day', 'under_week', 'week_or_more']),
    count: z.number().int().nonnegative(),
  }),
);
export type InboxSummary = z.infer<typeof InboxSummarySchema>;

/** GET /v1/approvals/inbox/count: how many requests the caller may decide now (the inbox list's total). */
export const InboxCountDtoSchema = z.object({
  count: z.number().int().min(0),
});
export type InboxCountDto = z.infer<typeof InboxCountDtoSchema>;

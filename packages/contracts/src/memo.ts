// The internal memo ("test memo") document. P1 used it to exercise every kernel service end to end, with an
// amount, a currency and attachments; from P2 a template memo is correspondence with no money. Fields follow app.test_memos in section 4.
import { z } from 'zod';

import { HexColourSchema, LogoDataUrlSchema } from './document-style.js';
import { multi, searchParam } from './list-query.js';
import { CurrencySchema, DecimalString, RateString } from './money.js';

export const MEMO_STATUSES = ['draft', 'submitted', 'approved', 'returned', 'rejected'] as const;
export const MemoStatusSchema = z.enum(MEMO_STATUSES);

export const MemoPersonSchema = z.object({
  userId: z.guid(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  department: z.string().nullable(),
});
export type MemoPerson = z.infer<typeof MemoPersonSchema>;
/** How many "Recommended by" signers a memo can name. The form and the API both read this one number. */
export const MEMO_MAX_RECOMMENDERS = 20;
export const MemoTemplateInputSchema = z
  .object({
    departmentId: z.guid(),
    date: z.iso.date(),
    closing: z.string().trim().max(1000),
    preparedByUserId: z.guid(),
    recommenderUserIds: z.array(z.guid()).max(MEMO_MAX_RECOMMENDERS),
    approvedByUserId: z.guid(),
  })
  .superRefine((v, ctx) => {
    const ids = [v.preparedByUserId, ...v.recommenderUserIds, v.approvedByUserId];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Choose different people for each role' });
  });
/**
 * The memo letterhead: the entity's address (as the quotation footer prints it, one part per line), its logo as bytes
 * and its brand colour. The directory carries the live values for a draft; submit freezes them onto the memo, so a
 * later logo or address change never alters a memo that was sent for approval. A memo stored before letterheads has
 * none, and still reads. A line joins address parts (city and district: up to 100 + 2 + 100 characters), so the
 * per-line cap sits above any line the address settings can produce; the line count keeps the whole bounded.
 */
export const LetterheadSchema = z.object({
  addressLines: z.array(z.string().max(400)).max(4),
  logoDataUrl: LogoDataUrlSchema.nullable(),
  primaryColour: HexColourSchema,
});
export type Letterhead = z.infer<typeof LetterheadSchema>;
export const MemoTemplateSnapshotSchema = z.object({
  organizationId: z.guid(),
  organizationName: z.string(),
  /** Frozen at submit; absent on a draft and on a memo stored before letterheads. */
  letterhead: LetterheadSchema.optional(),
  departmentId: z.guid(),
  departmentName: z.string(),
  date: z.iso.date(),
  closing: z.string(),
  preparedBy: MemoPersonSchema,
  recommenders: z.array(MemoPersonSchema),
  approvedBy: MemoPersonSchema,
});
export type MemoTemplateSnapshot = z.infer<typeof MemoTemplateSnapshotSchema>;
/**
 * A person of the memo directory. `canApprove` says whether their roles hold a live `approvals.requests.act` grant
 * (the role_permissions rows, as the approval routes check them): only such people can decide a memo, so only they
 * may be named as a recommender or approver. It is a directory fact, never stored on a memo.
 */
export const MemoDirectoryPersonSchema = MemoPersonSchema.extend({
  canApprove: z.boolean(),
  /** The person's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  avatarDocumentId: z.guid().nullable().optional(),
});
export type MemoDirectoryPerson = z.infer<typeof MemoDirectoryPersonSchema>;
/**
 * Who may approve a memo (F1-Q9): the published "Memo approver" workflow in Settings > Workflows (documentType
 * `memo_approver`), one step, by default the head of the requester's department. The author picks "Approved by"
 * from `eligibleUserIds` only, and submit checks the pick again.
 * - `department_head`: the requester's department head approves (`defaultUserId`).
 * - `fallback`: the step falls back to `roleKey`, because the requester has no department, it has no active head,
 *   or the head is the requester (or edited the memo); anyone eligible in that role may be picked.
 * - `workflow`: an administrator set a role, group or person step instead of the department head.
 * `eligibleUserIds` empty: nobody can approve; `blockReason` says what to fix (no one is picked automatically and
 * no grant is widened).
 */
export const MEMO_APPROVER_DOCUMENT_TYPE = 'memo_approver';
export const MemoApproverRuleSchema = z.object({
  basis: z.enum(['department_head', 'fallback', 'workflow']),
  /** The requester's department in this entity, null for "No department". */
  departmentId: z.guid().nullable(),
  departmentName: z.string().nullable(),
  roleKey: z.string().optional(),
  /** The role's display name, for the form's hint. */
  roleName: z.string().optional(),
  eligibleUserIds: z.array(z.guid()),
  defaultUserId: z.guid().nullable(),
  blockReason: z.string().optional(),
});
export type MemoApproverRule = z.infer<typeof MemoApproverRuleSchema>;

/** The Memo approver workflow a new entity starts with: the department head, else the Founder (F1-Q9). */
export const MEMO_APPROVER_DEFAULT_SPEC = {
  documentType: MEMO_APPROVER_DOCUMENT_TYPE,
  steps: [
    {
      id: 'approver',
      kind: 'department_head',
      fallbackRole: 'founder',
      reason: "The head of the requester's department approves the memo",
    },
  ],
  rules: [],
} as const;

export const MemoDirectorySchema = z.object({
  organizationId: z.guid(),
  organizationName: z.string(),
  /** The live letterhead a draft shows; absent when the entity's settings do not form a valid one. */
  letterhead: LetterheadSchema.optional(),
  currentUserId: z.guid(),
  departmentId: z.guid().nullable(),
  departments: z.array(z.object({ id: z.guid(), name: z.string() })),
  people: z.array(MemoDirectoryPersonSchema),
  /** Who may approve a new memo of the caller (F1-Q9). Absent from an API that predates it. */
  approverRule: MemoApproverRuleSchema.optional(),
});
export type MemoDirectory = z.infer<typeof MemoDirectorySchema>;

/**
 * The memo fields before the legacy money rule below. Kept unrefined so callers can read `.shape` (the PATCH body)
 * or validate a field subset (the Workspace edit form) without tripping over a refined object.
 */
export const MemoBodyFieldsSchema = z.object({
  template: MemoTemplateInputSchema.optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000),
  /**
   * Legacy P1 test value; internal correspondence has no money. The table has CHECK (amount >= 0), so a negative
   * amount is refused here with a clear message. Optional only together with `template` (see CreateMemoBodySchema).
   */
  amount: DecimalString.refine((v) => !v.startsWith('-'), 'must not be negative').optional(),
  currency: CurrencySchema.optional(),
  /**
   * The customer party a portal would show this memo to (ADR 0027 §5); omit or null for an internal memo. The
   * database checks that it is a customer party of the tenant (test_memos_customer_party_fk).
   */
  customerPartyId: z.guid().nullable().optional(),
});

/**
 * Create body. A template memo is internal correspondence: it carries no amount or currency, and the API stores the
 * compatibility value NPR 0.00 (the columns are NOT NULL). A memo without a template is the legacy P1 test memo, so
 * it still has to say how much it is for.
 */
export const CreateMemoBodySchema = MemoBodyFieldsSchema.superRefine((v, ctx) => {
  if (v.template !== undefined) return;
  if (v.amount === undefined) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount is required' });
  }
  if (v.currency === undefined) {
    ctx.addIssue({ code: 'custom', path: ['currency'], message: 'currency is required' });
  }
});
export type CreateMemoBody = z.infer<typeof CreateMemoBodySchema>;

export const MemoDtoSchema = z.object({
  template: MemoTemplateSnapshotSchema.nullable().optional(),
  id: z.guid(),
  number: z.string(),
  title: z.string(),
  body: z.string(),
  amount: DecimalString,
  currency: CurrencySchema,
  amountNpr: DecimalString,
  fxRate: RateString,
  fxSource: z.string(),
  fxDate: z.iso.date(),
  status: MemoStatusSchema,
  ownerUserId: z.guid(),
  departmentId: z.guid().nullable(),
  /** The customer party a portal would show this memo to (ADR 0027 §5); null for internal memos. */
  customerPartyId: z.guid().nullable(),
  editorUserIds: z.array(z.guid()),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MemoDto = z.infer<typeof MemoDtoSchema>;

/** Rows per page of the memo list: small default, hard ceiling, so a page is always cheap to build. */
export const MEMO_LIST_DEFAULT_LIMIT = 20;
export const MEMO_LIST_MAX_LIMIT = 50;

/**
 * Query of `GET /v1/test-memos`. Rows come newest first, ties broken by id, so a page boundary never skips or
 * repeats a memo. `cursor` is the opaque `nextCursor` of the previous page; a made-up one is a 400. `status`
 * may repeat; `q` finds a memo by number, title or the owner's name (exact substring: fuzzy matching would
 * reorder rows by similarity, which a keyset cursor on created_at cannot follow).
 */
export const MemoListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MEMO_LIST_MAX_LIMIT).default(MEMO_LIST_DEFAULT_LIMIT),
  cursor: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9_-]+$/, 'cursor is not valid')
    .optional(),
  status: multi(MemoStatusSchema),
  q: searchParam,
});
export type MemoListQuery = z.infer<typeof MemoListQuerySchema>;

/** One row of the memo list: enough to find a memo and open it, never its body or signers. */
export const MemoListItemSchema = z.object({
  id: z.guid(),
  number: z.string(),
  title: z.string(),
  status: MemoStatusSchema,
  amount: DecimalString,
  currency: CurrencySchema,
  ownerUserId: z.guid(),
  /** Display name of the creator; null when the directory has none. */
  ownerName: z.string().nullable(),
  /** The creator's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  ownerAvatarDocumentId: z.guid().nullable().optional(),
  departmentName: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MemoListItem = z.infer<typeof MemoListItemSchema>;

export const MemoListSchema = z.object({
  items: z.array(MemoListItemSchema),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  /** Every memo the caller may open that matches the filters, not just this page. */
  total: z.number().int().min(0),
});
export type MemoList = z.infer<typeof MemoListSchema>;

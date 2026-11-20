// The memo form's data as plain functions, so the rules the screen depends on are unit-tested without a browser:
// what the live paper is built from, and how a half-typed form becomes a saved working draft and back.
import {
  MEMO_MAX_RECOMMENDERS,
  type MemoDirectory,
  type MemoTemplateSnapshot,
} from '@bos/contracts';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import type { MemoDraftValues } from '@/lib/memo-working-draft-types';

import type { MemoValues } from './actions';
import { initialRecommenders, recommenderPayload, type RecommenderRows } from './signer-rows';

export const DEFAULT_CLOSING = 'Submitted for your approval.';

/** Everything the letterhead part of the form edits. `recommenders` keeps blank rows: they are "not used yet". */
export interface TemplateFields {
  departmentId: string;
  /** `YYYY-MM-DD`, or '' while the date picker holds an incomplete date. */
  date: string;
  closing: string;
  recommenders: RecommenderRows;
  approvedBy: string;
}

export function initialTemplateFields(
  template: MemoTemplateSnapshot | null | undefined,
  directory: MemoDirectory | undefined,
  // The tenant's calendar day: a UTC date is still yesterday between 00:00 and 05:45 Nepal time.
  today: string = todayInKathmandu(),
): TemplateFields {
  return {
    departmentId: template?.departmentId ?? directory?.departmentId ?? '',
    date: template?.date ?? today,
    closing: template?.closing ?? DEFAULT_CLOSING,
    // A new memo starts with two blank rows; an edit keeps exactly what was saved.
    recommenders: initialRecommenders(template?.recommenders.map((p) => p.userId)),
    // A new memo starts with the approver the Memo approver rule names (the department head), when it names one.
    approvedBy: template?.approvedBy.userId ?? directory?.approverRule?.defaultUserId ?? '',
  };
}

const personOf = (directory: MemoDirectory, id: string) =>
  directory.people.find((p) => p.userId === id) ?? {
    userId: id,
    name: '',
    jobTitle: null,
    department: null,
  };

/**
 * The paper's template for the current form state. A pure function of its inputs: whatever is typed or picked
 * reaches the paper on the same render. Blank recommender rows never reach it.
 *
 * The letterhead is always the directory's live one: the form edits only drafts and returned memos, and submit
 * freezes the then-current letterhead again. A letterhead frozen by an earlier submit is never shown here.
 */
export function buildPreviewTemplate(
  directory: MemoDirectory,
  saved: MemoTemplateSnapshot | null | undefined,
  fields: TemplateFields,
  preparedByUserId: string,
): MemoTemplateSnapshot {
  return {
    organizationId: directory.organizationId,
    organizationName: saved?.organizationName ?? directory.organizationName,
    ...(directory.letterhead ? { letterhead: directory.letterhead } : {}),
    departmentId: fields.departmentId,
    departmentName: directory.departments.find((d) => d.id === fields.departmentId)?.name ?? '',
    date: fields.date,
    closing: fields.closing,
    preparedBy: personOf(directory, preparedByUserId),
    recommenders: recommenderPayload(fields.recommenders).map((id) => personOf(directory, id)),
    approvedBy: personOf(directory, fields.approvedBy),
  };
}

/** What the server action receives as `template`: no blank rows. */
export function templateInputOf(fields: TemplateFields, preparedByUserId: string) {
  return {
    departmentId: fields.departmentId,
    date: fields.date,
    closing: fields.closing,
    preparedByUserId,
    recommenderUserIds: recommenderPayload(fields.recommenders),
    approvedByUserId: fields.approvedBy,
  };
}

// ---- Working draft <-> form ------------------------------------------------------------------------------------

/**
 * The draft's `template` is an opaque string to the server. Here it carries the letterhead fields, blank recommender
 * rows included (so a restored form has the same rows), and never the preparer: the preparer is always the signed-in
 * account, whatever an old draft says.
 */
interface DraftTemplateV1 {
  v: 1;
  departmentId: string;
  date: string;
  closing: string;
  recommenders: string[];
  approvedBy: string;
}

export function draftValuesOf(values: MemoValues, fields: TemplateFields | null): MemoDraftValues {
  const base: MemoDraftValues = {
    title: values.title,
    body: values.body,
    amount: '',
    currency: 'NPR',
  };
  if (!fields) return base;
  const template: DraftTemplateV1 = {
    v: 1,
    departmentId: fields.departmentId,
    date: fields.date,
    closing: fields.closing,
    recommenders: fields.recommenders,
    approvedBy: fields.approvedBy,
  };
  return { ...base, template: JSON.stringify(template) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Reads a draft's template string defensively. Anything unknown or foreign to this company's directory is dropped. */
export function parseDraftTemplate(
  raw: string | undefined,
  directory: MemoDirectory,
  current: TemplateFields,
): TemplateFields {
  if (!raw) return current;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return current;
  }
  if (typeof parsed !== 'object' || parsed === null) return current;
  const bag = parsed as Record<string, unknown>;
  const known = new Set(directory.people.map((p) => p.userId));
  const departmentId = asString(bag.departmentId);
  const date = asString(bag.date);
  const closing = asString(bag.closing);
  const approvedBy = asString(bag.approvedBy);
  const rows = Array.isArray(bag.recommenders)
    ? bag.recommenders
        .slice(0, MEMO_MAX_RECOMMENDERS)
        .map((id) => (typeof id === 'string' && known.has(id) ? id : ''))
    : null;
  return {
    departmentId:
      departmentId !== null && directory.departments.some((d) => d.id === departmentId)
        ? departmentId
        : current.departmentId,
    date: date !== null && (date === '' || ISO_DATE.test(date)) ? date : current.date,
    closing: closing !== null ? closing.slice(0, 1000) : current.closing,
    recommenders: rows ?? current.recommenders,
    approvedBy: approvedBy !== null && known.has(approvedBy) ? approvedBy : current.approvedBy,
  };
}

export function restoreFromDraft(
  draft: MemoDraftValues,
  directory: MemoDirectory | undefined,
  current: { values: MemoValues; fields: TemplateFields },
): { values: MemoValues; fields: TemplateFields } {
  return {
    values: {
      ...current.values,
      title: draft.title,
      body: draft.body,
    },
    fields: directory
      ? parseDraftTemplate(draft.template, directory, current.fields)
      : current.fields,
  };
}

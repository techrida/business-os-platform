import { ACTIVITY_SUBJECT_KEYS, type ActivityCan, type ActivityDto } from '@bos/contracts';

/** The record a follow-up hangs off: a lead, an opportunity, a customer, a contact or a quotation. */
export type FollowUpSubjectKind = (typeof ACTIVITY_SUBJECT_KEYS)[number];

export interface FollowUpSubject {
  kind: FollowUpSubjectKind;
  id: string;
}

export const isFollowUpSubjectKind = (value: unknown): value is FollowUpSubjectKind =>
  typeof value === 'string' && (ACTIVITY_SUBJECT_KEYS as readonly string[]).includes(value);

/** The one subject an activity carries (the API enforces exactly one), or null when none is set. */
export function subjectOf(
  item: Partial<Pick<ActivityDto, FollowUpSubjectKind>>,
): FollowUpSubject | null {
  for (const kind of ACTIVITY_SUBJECT_KEYS) {
    const id = item[kind];
    if (typeof id === 'string' && id !== '') return { kind, id };
  }
  return null;
}

/**
 * The pages that show a subject's follow-ups, most specific first, always ending with
 * `/activities`. Built on the server from a validated kind and id, never taken from the browser.
 * A contact has no page of its own, so it refreshes `/activities` only.
 */
export function followUpPaths(subject: FollowUpSubject | null): string[] {
  const own =
    subject === null
      ? []
      : subject.kind === 'leadId'
        ? [`/leads/${subject.id}`, '/leads']
        : subject.kind === 'opportunityId'
          ? [`/opportunities/${subject.id}`]
          : subject.kind === 'customerId'
            ? [`/customers/${subject.id}`]
            : subject.kind === 'quotationId'
              ? [`/quotations/${subject.id}`]
              : [];
  return [...own, '/activities'];
}

const NO_ACTIONS: ActivityCan = Object.freeze({
  complete: false,
  reschedule: false,
  cancel: false,
});

/**
 * Which of Complete, Reschedule and Cancel a follow-up offers: the row's `can` flags, which the API works out
 * with the same rule its write routes enforce. A row without them (a write route's answer) offers nothing.
 */
export function followUpActionsFor(item: Pick<ActivityDto, 'can'>): ActivityCan {
  const can = item.can;
  if (can === undefined) return NO_ACTIONS;
  return { complete: can.complete, reschedule: can.reschedule, cancel: can.cancel };
}

/** Whether a follow-up offers any action at all. */
export const hasFollowUpActions = (can: ActivityCan): boolean =>
  can.complete || can.reschedule || can.cancel;

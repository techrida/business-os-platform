import { ACTIVITY_SUBJECT_KEYS, type ActivityDto } from '@bos/contracts';

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

/**
 * The permission that moves or calls off a follow-up on each kind of subject: the subject's write, as the API's
 * `SUBJECT_PERMISSION` asks (activities.types.ts). Completing your own follow-up needs only the read.
 */
export const FOLLOW_UP_WRITE: Readonly<Record<FollowUpSubjectKind, string>> = {
  leadId: 'crm.lead.write',
  opportunityId: 'crm.opportunity.write',
  customerId: 'customer.write',
  contactId: 'customer.write',
  quotationId: 'quotation.draft',
};

/**
 * Which actions a planned follow-up offers outside its record's page (the /activities list), the record page's
 * rule (FollowUpList): `all` with the subject's write, `complete` for the caller's own follow-up without it
 * (U20a2-Q7: an assignee finishes their work), `none` for anyone else, so no button is shown that the API
 * would only refuse. Only permission names are known here, not their scope.
 */
export function followUpActionsFor(
  item: Pick<ActivityDto, FollowUpSubjectKind | 'assigneeUserId'>,
  can: (permission: string) => boolean,
  currentUserId: string | null | undefined,
): 'all' | 'complete' | 'none' {
  const subject = subjectOf(item);
  if (subject !== null && can(FOLLOW_UP_WRITE[subject.kind])) return 'all';
  if (currentUserId != null && item.assigneeUserId === currentUserId) return 'complete';
  return 'none';
}

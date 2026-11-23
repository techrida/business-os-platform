import type { MemoDirectory } from '@bos/contracts';

import { MEMBER_GROUPING_THRESHOLD, type MemberOption } from '@/components/ui/member-picker';

/** More staff than this and the list is grouped by their real directory department. */
export const STAFF_GROUPING_THRESHOLD = MEMBER_GROUPING_THRESHOLD;

type Person = MemoDirectory['people'][number];

/**
 * The people a Recommended or Approved field may offer: those who can decide approvals (the server worked out
 * `canApprove` from their live roles). The person already in this field stays listed, so a saved memo keeps showing
 * its names; the server refuses to submit one who has since lost the right.
 */
export function approverChoices(people: readonly Person[], own: string): readonly Person[] {
  return people.filter((p) => p.canApprove || p.userId === own);
}

/**
 * The directory as the member picker takes it (BOS-UI-001): the role is the job title and department, the same line
 * in the list row and in the closed field. Two people can share a name; the picker adds a short reference to a
 * duplicate, so they are never told apart by name alone.
 */
export function memoMembers(
  people: readonly Person[],
  opts: { disabledIds?: ReadonlySet<string>; grouped?: boolean } = {},
): MemberOption[] {
  const grouped = opts.grouped ?? people.length > STAFF_GROUPING_THRESHOLD;
  return people.map((p) => {
    const disabled = opts.disabledIds?.has(p.userId) === true;
    return {
      id: p.userId,
      name: p.name,
      // In a grouped list the department is the heading; in a flat one it is part of the line.
      role: [p.jobTitle, grouped ? null : p.department].filter(Boolean).join(' · ') || null,
      group: p.department,
      disabled: disabled || undefined,
      disabledReason: disabled ? 'Already chosen' : undefined,
    };
  });
}

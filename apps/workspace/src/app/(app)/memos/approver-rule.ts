// Who may sign "Approved by" (F1-Q9): the API's Memo approver rule, turned into the picker's choices and the hint
// under it. Plain functions, so the wording and the narrowing are unit-tested without a browser.
import type { MemoApproverRule, MemoDirectory } from '@bos/contracts';

import { approverChoices } from './memo-members';

type Person = MemoDirectory['people'][number];

/**
 * The people "Approved by" lists: those the rule allows, plus whoever is already chosen (so a saved pick the rule no
 * longer allows stays visible to be replaced; submit refuses it). Without a rule (an older API), everyone who can
 * decide approvals.
 */
export function ruleApproverChoices(
  people: readonly Person[],
  rule: MemoApproverRule | undefined,
  own: string,
): readonly Person[] {
  if (rule === undefined) return approverChoices(people, own);
  const allowed = new Set(rule.eligibleUserIds);
  return people.filter((p) => allowed.has(p.userId) || p.userId === own);
}

/** Why these people are listed, in the words of the rule; when nobody qualifies, what to fix. */
export function approverHint(rule: MemoApproverRule): string {
  if (rule.blockReason !== undefined) return rule.blockReason;
  const role = rule.roleName ?? rule.roleKey;
  switch (rule.basis) {
    case 'department_head':
      return `The head of ${rule.departmentName ?? "the author's department"} approves this memo.`;
    case 'fallback': {
      const why =
        rule.departmentId === null
          ? 'The author is in no department'
          : rule.headCannotApprove === true
            ? `The head of ${rule.departmentName ?? "the author's department"} cannot decide approvals`
            : `${rule.departmentName ?? "The author's department"} has no department head who can approve`;
      return role === undefined
        ? `${why}, so the Memo approver workflow names who approves instead.`
        : `${why}, so someone in the ${role} role approves instead.`;
    }
    case 'workflow':
      return role === undefined
        ? 'Only the people the Memo approver workflow names are listed.'
        : `Someone in the ${role} role approves this memo.`;
  }
}

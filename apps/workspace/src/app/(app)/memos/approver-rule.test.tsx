import type { MemoApproverRule, MemoDirectory } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { approverHint, ruleApproverChoices } from './approver-rule';
import { initialTemplateFields } from './memo-form-model';
import { SignerSection } from './signer-section';

const ME = '11111111-1111-4111-8111-111111111111';
const HEAD = '22222222-2222-4222-8222-222222222222';
const FOUNDER = '33333333-3333-4333-8333-333333333333';
const CLERK = '44444444-4444-4444-8444-444444444444';
const DEPT = '55555555-5555-4555-8555-555555555555';

const person = (userId: string, name: string, canApprove = true) => ({
  userId,
  name,
  jobTitle: null,
  department: null,
  canApprove,
});
const people = [
  person(ME, 'Dev Sales', false),
  person(HEAD, 'Hari Head'),
  person(FOUNDER, 'Fiona Founder'),
  person(CLERK, 'Kiran Clerk'),
];
const headRule: MemoApproverRule = {
  basis: 'department_head',
  departmentId: DEPT,
  departmentName: 'Operations',
  eligibleUserIds: [HEAD],
  defaultUserId: HEAD,
};
const directory = (approverRule?: MemoApproverRule): MemoDirectory => ({
  organizationId: '66666666-6666-4666-8666-666666666666',
  organizationName: 'Techrida Pvt. Ltd.',
  currentUserId: ME,
  departmentId: DEPT,
  departments: [{ id: DEPT, name: 'Operations' }],
  people,
  ...(approverRule ? { approverRule } : {}),
});
const ids = (list: readonly { userId: string }[]) => list.map((p) => p.userId);

describe('Approved by follows the Memo approver rule (F1-Q9)', () => {
  it('lists only who the rule allows, and keeps a saved pick visible so it can be replaced', () => {
    expect(ids(ruleApproverChoices(people, headRule, ''))).toEqual([HEAD]);
    expect(ids(ruleApproverChoices(people, headRule, CLERK))).toEqual([HEAD, CLERK]);
  });

  it('falls back to everyone who can decide approvals when the API sends no rule', () => {
    expect(ids(ruleApproverChoices(people, undefined, ''))).toEqual([HEAD, FOUNDER, CLERK]);
  });

  it('starts a new memo with the department head, and keeps a saved approver', () => {
    expect(initialTemplateFields(null, directory(headRule), '2026-11-20').approvedBy).toBe(HEAD);
    expect(initialTemplateFields(null, directory(), '2026-11-20').approvedBy).toBe('');
    expect(
      initialTemplateFields(null, directory({ ...headRule, defaultUserId: null }), '2026-11-20')
        .approvedBy,
    ).toBe('');
  });

  it('says why: the head, or the fallback role and why it applies', () => {
    expect(approverHint(headRule)).toBe('The head of Operations approves this memo.');
    const fallback: MemoApproverRule = {
      ...headRule,
      basis: 'fallback',
      roleKey: 'founder',
      roleName: 'Founder',
      eligibleUserIds: [FOUNDER],
      defaultUserId: FOUNDER,
    };
    expect(approverHint(fallback)).toBe(
      'Operations has no department head who can approve, so someone in the Founder role approves instead.',
    );
    expect(approverHint({ ...fallback, headCannotApprove: true })).toBe(
      'The head of Operations cannot decide approvals, so someone in the Founder role approves instead.',
    );
    expect(approverHint({ ...fallback, departmentId: null, departmentName: null })).toBe(
      'The author is in no department, so someone in the Founder role approves instead.',
    );
    expect(
      approverHint({
        ...fallback,
        basis: 'workflow',
        roleKey: 'management',
        roleName: 'Management',
      }),
    ).toBe('Someone in the Management role approves this memo.');
  });

  it('shows the dead end and its fix when nobody can approve', () => {
    const blocked: MemoApproverRule = {
      ...headRule,
      eligibleUserIds: [],
      defaultUserId: null,
      blockReason: 'The head of Operations cannot decide approvals. An administrator fixes it.',
    };
    expect(approverHint(blocked)).toBe(blocked.blockReason);
    const html = renderToStaticMarkup(
      <SignerSection
        people={people}
        currentUserId={ME}
        recommenders={['', '']}
        onRecommenders={() => undefined}
        approvedBy=""
        onApprovedBy={() => undefined}
        approverRule={blocked}
      />,
    );
    expect(html).toContain('The head of Operations cannot decide approvals.');
  });

  it('shows the hint under Approved by on the form', () => {
    const html = renderToStaticMarkup(
      <SignerSection
        people={people}
        currentUserId={ME}
        recommenders={['', '']}
        onRecommenders={() => undefined}
        approvedBy={HEAD}
        onApprovedBy={() => undefined}
        approverRule={headRule}
      />,
    );
    expect(html).toContain('The head of Operations approves this memo.');
  });

  it('marks Recommended by Optional beside its label, not in its hint (UIP-FORM-008)', () => {
    const html = renderToStaticMarkup(
      <SignerSection
        people={people}
        currentUserId={ME}
        recommenders={['', '']}
        onRecommenders={() => undefined}
        approvedBy={HEAD}
        onApprovedBy={() => undefined}
        approverRule={headRule}
      />,
    );
    expect(html).toMatch(/Recommended by<\/span><span[^>]*>Optional<\/span>/);
    expect(html).not.toContain('Optional. Only people');
    expect(html).toContain('Only people who can decide approvals are listed.');
  });
});

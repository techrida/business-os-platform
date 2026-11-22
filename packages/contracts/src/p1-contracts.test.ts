import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MIME,
  ApprovalActionBodySchema,
  ApprovalActionKindSchema,
  ApprovalRequestStatusSchema,
  ConditionSchema,
  CreateDocumentBodySchema,
  CreateMemoBodySchema,
  DEFAULT_ROLE_PERMISSIONS,
  DecimalString,
  ErrorBodySchema,
  MAX_UPLOAD_BYTES,
  MemoBodyFieldsSchema,
  MemoDirectorySchema,
  MemoPersonSchema,
  NprSnapshotSchema,
  PERMISSIONS,
  PublishWorkflowVersionBodySchema,
  ROLE_KEYS,
  SCOPES,
  SETTINGS,
  SOD_PERMISSIONS,
  StepSpecSchema,
  WORKFLOW_AMOUNT_ERROR,
  WORKFLOW_AMOUNT_NEGATIVE_ERROR,
  WorkflowSpecSchema,
  WorkflowWriteSpecSchema,
} from './index.js';

const leaf = { field: 'amountNpr', op: 'gt', value: '100000' } as const;

describe('ConditionSchema', () => {
  it('parses a leaf and nested all/any (recursion)', () => {
    const nested = { all: [leaf, { any: [leaf, { all: [{ ...leaf, op: 'lte', value: 5 }] }] }] };
    expect(ConditionSchema.safeParse(nested).success).toBe(true);
  });

  it('accepts op "in" with a list and rejects it with a scalar', () => {
    expect(ConditionSchema.safeParse({ field: 'dept', op: 'in', value: ['a', 'b'] }).success).toBe(
      true,
    );
    expect(ConditionSchema.safeParse({ field: 'dept', op: 'in', value: 'a' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...leaf, value: ['a'] }).success).toBe(false);
  });

  it('rejects a bad op, an empty all/any and a mixed object', () => {
    expect(ConditionSchema.safeParse({ ...leaf, op: 'like' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ all: [] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ any: [] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ all: [leaf], any: [leaf] }).success).toBe(false);
  });

  it('rejects a bad condition nested deep inside', () => {
    expect(ConditionSchema.safeParse({ all: [{ any: [{ all: [{ field: 'x' }] }] }] }).success).toBe(
      false,
    );
  });
});

describe('StepSpecSchema', () => {
  it('requires the field the kind names', () => {
    expect(
      StepSpecSchema.safeParse({ id: 's1', kind: 'role', role: 'finance', reason: 'r' }).success,
    ).toBe(true);
    expect(StepSpecSchema.safeParse({ id: 's1', kind: 'role', reason: 'r' }).success).toBe(false);
    expect(
      StepSpecSchema.safeParse({ id: 's1', kind: 'role', role: 'ceo', reason: 'r' }).success,
    ).toBe(false);
  });
});

describe('workflow amount threshold writes', () => {
  it.each(['1.01', '1.005', 1.01])('validates nested money threshold %s', (value) => {
    const spec = {
      documentType: 'test_memo',
      steps: [],
      rules: [
        {
          id: 'escalate',
          when: { all: [{ field: 'amountNpr', op: 'gte', value }] },
          add: { id: 'finance', kind: 'role', role: 'finance', reason: 'Review' },
          reason: 'Review',
        },
      ],
    };
    expect(WorkflowSpecSchema.safeParse(spec).success).toBe(true);
    expect(WorkflowWriteSpecSchema.safeParse(spec).success).toBe(value === '1.01');
  });

  const thresholdSpec = (value: string | string[], op = 'gte') => ({
    documentType: 'test_memo',
    steps: [],
    rules: [
      {
        id: 'escalate',
        when: { any: [{ field: 'amountNpr', op, value }] },
        add: { id: 'finance', kind: 'role', role: 'finance', reason: 'Review' },
        reason: 'Review',
      },
    ],
  });
  const messages = (value: string | string[], op?: string) => {
    const parsed = WorkflowWriteSpecSchema.safeParse(thresholdSpec(value, op));
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  };

  it.each(['-5', '-0.01', '-0', ' -100'])('refuses the signed threshold %j', (value) => {
    expect(messages(value)).toEqual([WORKFLOW_AMOUNT_NEGATIVE_ERROR]);
  });

  it('refuses a negative inside an in-list and names the sign, not the decimals', () => {
    expect(messages(['100', '-1'], 'in')).toEqual([WORKFLOW_AMOUNT_NEGATIVE_ERROR]);
  });

  it.each(['0', '0.00', '100000', '1000000.00'])('accepts the unsigned threshold %s', (value) => {
    expect(messages(value)).toEqual([]);
  });

  it('keeps the decimals message for a stored value with three decimals', () => {
    expect(messages('100000.000')).toEqual([WORKFLOW_AMOUNT_ERROR]);
  });

  it('still reads a published spec that holds a negative threshold', () => {
    expect(WorkflowSpecSchema.safeParse(thresholdSpec('-5')).success).toBe(true);
  });
});

describe('WorkflowSpecSchema', () => {
  const step = { id: 'a', kind: 'role', role: 'accountant', reason: 'check' } as const;

  it('fills the defaults: no rules, distinct approvers, 24h/72h SLA to founder', () => {
    const spec = WorkflowSpecSchema.parse({ documentType: 'test_memo', steps: [step] });
    expect(spec.rules).toEqual([]);
    expect(spec.distinctApprovers).toBe(true);
    expect(spec.sla).toEqual({
      remindAfterHours: 24,
      escalateAfterHours: 72,
      escalateTo: { role: 'founder' },
    });
  });

  it('keeps the field defaults when sla is given partially', () => {
    const spec = WorkflowSpecSchema.parse({
      documentType: 't',
      steps: [step],
      sla: { escalateAfterHours: 48 },
    });
    expect(spec.sla.remindAfterHours).toBe(24);
    expect(spec.sla.escalateAfterHours).toBe(48);
  });

  it('defaults a rule position to the end and accepts {after}', () => {
    const rule = { id: 'r1', when: leaf, add: { ...step, id: 'b' }, reason: 'big' };
    const spec = WorkflowSpecSchema.parse({
      documentType: 't',
      steps: [step],
      rules: [rule, { ...rule, id: 'r2', add: { ...step, id: 'c' }, position: { after: 'a' } }],
    });
    expect(spec.rules[0]?.position).toBe('end');
    expect(spec.rules[1]?.position).toEqual({ after: 'a' });
  });

  it('rejects duplicate step ids, an unknown {after} and an SLA that escalates before it reminds', () => {
    expect(WorkflowSpecSchema.safeParse({ documentType: 't', steps: [step, step] }).success).toBe(
      false,
    );
    const rule = {
      id: 'r1',
      when: leaf,
      add: { ...step, id: 'b' },
      position: { after: 'nope' },
      reason: 'x',
    };
    expect(
      WorkflowSpecSchema.safeParse({ documentType: 't', steps: [step], rules: [rule] }).success,
    ).toBe(false);
    expect(
      WorkflowSpecSchema.safeParse({
        documentType: 't',
        steps: [step],
        sla: { remindAfterHours: 10, escalateAfterHours: 10 },
      }).success,
    ).toBe(false);
  });
});

describe('ApprovalActionBodySchema', () => {
  it('lets approve go without a comment', () => {
    expect(
      ApprovalActionBodySchema.safeParse({ action: 'approve', expectedVersion: 1 }).success,
    ).toBe(true);
  });

  it.each(['return', 'reject'])('requires a comment to %s', (action) => {
    const missing = ApprovalActionBodySchema.safeParse({ action, expectedVersion: 1 });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['comment']);
    expect(
      ApprovalActionBodySchema.safeParse({ action, expectedVersion: 1, comment: '   ' }).success,
    ).toBe(false);
    expect(
      ApprovalActionBodySchema.safeParse({ action, expectedVersion: 1, comment: 'why' }).success,
    ).toBe(true);
  });

  it('caps the comment at 2000 characters and needs an integer version', () => {
    const long = 'x'.repeat(2001);
    expect(
      ApprovalActionBodySchema.safeParse({ action: 'reject', expectedVersion: 1, comment: long })
        .success,
    ).toBe(false);
    expect(
      ApprovalActionBodySchema.safeParse({ action: 'approve', expectedVersion: 1.5 }).success,
    ).toBe(false);
    expect(ApprovalActionBodySchema.safeParse({ action: 'approve' }).success).toBe(false);
  });
});

describe('PublishWorkflowVersionBodySchema (F1-Q11 a)', () => {
  it('takes no body fields, or a trimmed reason for the small-team rule', () => {
    expect(PublishWorkflowVersionBodySchema.parse({})).toEqual({});
    expect(PublishWorkflowVersionBodySchema.parse({ reason: '  Only Founder here  ' })).toEqual({
      reason: 'Only Founder here',
    });
  });

  it('accepts a blank reason (the API answers sole_eligible_reason_required) and refuses extras', () => {
    expect(PublishWorkflowVersionBodySchema.parse({ reason: '   ' })).toEqual({ reason: '' });
    expect(PublishWorkflowVersionBodySchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(
      false,
    );
    expect(PublishWorkflowVersionBodySchema.safeParse({ soleEligible: true }).success).toBe(false);
  });
});

describe('approval action kinds and request statuses (K1 cancel)', () => {
  it('logs a cancel action and lets a request be cancelled', () => {
    expect(ApprovalActionKindSchema.safeParse('cancel').success).toBe(true);
    expect(ApprovalRequestStatusSchema.safeParse('cancelled').success).toBe(true);
  });

  it('does not offer cancel as an approver decision', () => {
    expect(
      ApprovalActionBodySchema.safeParse({ action: 'cancel', comment: 'x', expectedVersion: 1 })
        .success,
    ).toBe(false);
  });
});

describe('DecimalString', () => {
  it.each(['0', '12', '-5', '1250000.00', '0.5', '1234567890123456.99'])('accepts %s', (v) => {
    expect(DecimalString.safeParse(v).success).toBe(true);
  });

  it.each(['', '1.', '.5', '1.234', '1e5', ' 1', '1,000', '12345678901234567', 'abc', '--1'])(
    'rejects "%s"',
    (v) => {
      expect(DecimalString.safeParse(v).success).toBe(false);
    },
  );

  it('rejects a JSON number, which would lose precision', () => {
    expect(DecimalString.safeParse(12.5).success).toBe(false);
  });
});

describe('NprSnapshotSchema', () => {
  it('keeps an FX rate with six decimals, which an amount may not have', () => {
    const snap = {
      amountNpr: '13345.68',
      rate: '133.456789',
      rateSource: 'NRB',
      rateDate: '2025-07-17',
    };
    expect(NprSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(NprSnapshotSchema.safeParse({ ...snap, rateDate: '17-07-2025' }).success).toBe(false);
    expect(NprSnapshotSchema.safeParse({ ...snap, amountNpr: '1.234' }).success).toBe(false);
  });
});

describe('DEFAULT_ROLE_PERMISSIONS', () => {
  it('has exactly the role keys, and only valid permissions and scopes', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual([...ROLE_KEYS].sort());
    for (const grants of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      for (const [permission, scope] of Object.entries(grants)) {
        expect(PERMISSIONS).toContain(permission);
        expect(SCOPES).toContain(scope);
      }
    }
  });

  it('gives founder every permission at scope all and vendor users only the vendor-portal grants', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS.founder).sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(Object.values(DEFAULT_ROLE_PERMISSIONS.founder))).toEqual(new Set(['all']));
    // D03: a vendor user holds only the two vendor-portal grants, at its own company.
    expect(DEFAULT_ROLE_PERMISSIONS.vendor_user).toEqual({
      'portal.vendor.read': 'customer_org',
      'portal.vendor.submit': 'customer_org',
    });
  });

  it('matches the plan for the staff roles', () => {
    const { sales, finance, accountant, management } = DEFAULT_ROLE_PERMISSIONS;
    // The P1 grants; the P2 CRM and quotation grants are checked in p2-contracts.test.ts.
    expect(sales).toMatchObject({
      'memo.create': 'own',
      'memo.update': 'own',
      'memo.read': 'own',
      'documents.upload': 'own',
      'documents.read': 'own',
      'approvals.requests.read': 'own',
    });
    expect(sales['approvals.requests.act']).toBeUndefined();
    expect(finance['audit.read']).toBe('all');
    expect(accountant['audit.read']).toBeUndefined();
    expect(management['audit.read']).toBeUndefined();
    for (const role of [finance, accountant, management]) {
      expect(role['approvals.requests.act']).toBe('all');
      expect(role['memo.read']).toBe('all');
    }
  });

  it('lets every staff role set its own profile picture and founder anyone, and no portal role either', () => {
    for (const role of ROLE_KEYS) {
      const expected =
        role === 'founder'
          ? 'all'
          : role === 'customer_user' || role === 'vendor_user'
            ? undefined
            : 'own';
      expect(DEFAULT_ROLE_PERMISSIONS[role]['profile.avatar.write'], role).toBe(expected);
    }
    // Migration 0053 also gives `all` to a role holding admin.users.invite; by default only founder does.
    const inviters = ROLE_KEYS.filter(
      (role) => DEFAULT_ROLE_PERMISSIONS[role]['admin.users.invite'],
    );
    expect(inviters).toEqual(['founder']);
  });

  it('only lists real permissions as separation-of-duties permissions', () => {
    for (const p of SOD_PERMISSIONS) expect(PERMISSIONS).toContain(p);
  });
});

describe('documents and memo bodies', () => {
  const doc = {
    ownerType: 'test_memo',
    ownerId: '00000000-0000-4000-8000-000000000001',
    filename: 'invoice.pdf',
    declaredMime: 'application/pdf',
    sizeBytes: 1024,
  };

  it('accepts a normal body and rejects a path in the file name', () => {
    expect(CreateDocumentBodySchema.safeParse(doc).success).toBe(true);
    expect(CreateDocumentBodySchema.safeParse({ ...doc, filename: '../etc/passwd' }).success).toBe(
      false,
    );
    expect(CreateDocumentBodySchema.safeParse({ ...doc, filename: 'a\u0000.pdf' }).success).toBe(
      false,
    );
  });

  it('leaves the size limit and the type check to the service (413 and 415)', () => {
    expect(
      CreateDocumentBodySchema.safeParse({ ...doc, sizeBytes: MAX_UPLOAD_BYTES + 1 }).success,
    ).toBe(true);
    expect(
      CreateDocumentBodySchema.safeParse({ ...doc, declaredMime: 'application/x-msdownload' })
        .success,
    ).toBe(true);
    expect(ALLOWED_MIME).toContain('text/csv');
    expect(MAX_UPLOAD_BYTES).toBe(26_214_400);
  });

  it('refuses a negative or float memo amount', () => {
    const memo = { title: 'Laptop', body: '', amount: '1250.50', currency: 'NPR' };
    expect(CreateMemoBodySchema.safeParse(memo).success).toBe(true);
    expect(CreateMemoBodySchema.safeParse({ ...memo, amount: '-1' }).success).toBe(false);
    expect(CreateMemoBodySchema.safeParse({ ...memo, amount: 1250.5 }).success).toBe(false);
    expect(CreateMemoBodySchema.safeParse({ ...memo, currency: 'EUR' }).success).toBe(false);
  });

  it('requires amount and currency for a legacy memo but not for a template memo', () => {
    const user = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const template = {
      departmentId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      date: '2026-11-12',
      closing: '',
      preparedByUserId: user,
      recommenderUserIds: [],
      approvedByUserId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
    };
    const legacy = { title: 'Laptop', body: '' };
    expect(CreateMemoBodySchema.safeParse(legacy).success).toBe(false);
    expect(CreateMemoBodySchema.safeParse({ ...legacy, amount: '1.00' }).success).toBe(false);
    expect(CreateMemoBodySchema.safeParse({ ...legacy, currency: 'NPR' }).success).toBe(false);
    expect(CreateMemoBodySchema.safeParse({ ...legacy, template }).success).toBe(true);
    // A negative or malformed amount is still refused when it is sent with a template.
    expect(CreateMemoBodySchema.safeParse({ ...legacy, template, amount: '-1' }).success).toBe(
      false,
    );
    expect(MemoBodyFieldsSchema.safeParse(legacy).success).toBe(true);
  });
});

describe('MemoDirectorySchema', () => {
  const guid = (n: number) => `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(n).padStart(2, '0')}`;
  const directory = (canApprove: unknown) => ({
    organizationId: guid(1),
    organizationName: 'Dev Co',
    currentUserId: guid(2),
    departmentId: null,
    departments: [],
    people: [{ userId: guid(2), name: 'Dev Sales', jobTitle: null, department: null, canApprove }],
  });

  it('says per person whether they can decide approvals', () => {
    expect(MemoDirectorySchema.parse(directory(false)).people[0]?.canApprove).toBe(false);
    expect(MemoDirectorySchema.parse(directory(true)).people[0]?.canApprove).toBe(true);
  });

  it('refuses a person without the flag, so a client never guesses it', () => {
    expect(MemoDirectorySchema.safeParse(directory(undefined)).success).toBe(false);
  });

  it('keeps the printed person of a saved memo free of the live flag', () => {
    const person = { userId: guid(2), name: 'Dev Sales', jobTitle: null, department: null };
    expect(MemoPersonSchema.parse({ ...person, canApprove: true })).toEqual(person);
  });
});

describe('SETTINGS', () => {
  it('validates each setting value', () => {
    expect(SETTINGS['currency.enabled'].safeParse(['NPR', 'USD']).success).toBe(true);
    expect(SETTINGS['currency.enabled'].safeParse(['USD']).success).toBe(false);
    expect(SETTINGS['tax.vat_rate'].safeParse('13').success).toBe(true);
    expect(SETTINGS['tax.vat_rate'].safeParse('130').success).toBe(false);
    expect(SETTINGS['numbering.memo_prefix'].safeParse('MEMO').success).toBe(true);
    expect(SETTINGS['numbering.memo_prefix'].safeParse('memo').success).toBe(false);
    expect(SETTINGS['approvals.sla_defaults'].parse({}).remindAfterHours).toBe(24);
  });
});

describe('ErrorBodySchema reason', () => {
  const base = { code: 'forbidden', message: 'Forbidden', correlationId: 'req-12345678' };

  it('allows no reason, and a known reason', () => {
    expect(ErrorBodySchema.safeParse({ error: base }).success).toBe(true);
    expect(ErrorBodySchema.safeParse({ error: { ...base, reason: 'out_of_scope' } }).success).toBe(
      true,
    );
  });

  it('rejects an unknown reason', () => {
    expect(ErrorBodySchema.safeParse({ error: { ...base, reason: 'because' } }).success).toBe(
      false,
    );
  });
});

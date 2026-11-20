// The emergency review route (F1-Q41): a valid spec, and migration 0130 publishes exactly this spec.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/receipts/emergency-review.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { P4_DOCUMENT_TYPES, WorkflowSpecSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { EMERGENCY_REVIEW_DOCUMENT_TYPE, EMERGENCY_REVIEW_WORKFLOW_SPEC } from './emergency-review';

const MIGRATION = join(
  __dirname,
  '../../../../../../packages/db/migrations/0130_emergency_review_workflow.sql',
);

describe('EMERGENCY_REVIEW_WORKFLOW_SPEC', () => {
  it('is a valid spec: one Management step, reminded after 72 hours, escalated to the Founder', () => {
    const spec = WorkflowSpecSchema.parse(EMERGENCY_REVIEW_WORKFLOW_SPEC);
    expect(spec.documentType).toBe(EMERGENCY_REVIEW_DOCUMENT_TYPE);
    expect(spec.steps).toEqual([expect.objectContaining({ kind: 'role', role: 'management' })]);
    expect(spec.sla).toMatchObject({ remindAfterHours: 72, escalateTo: { role: 'founder' } });
    expect(P4_DOCUMENT_TYPES).toContain(EMERGENCY_REVIEW_DOCUMENT_TYPE);
  });

  it('is published word for word by migration 0130', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const literal = /spec constant jsonb := '([\s\S]*?)'::jsonb;/.exec(sql)?.[1];
    expect(literal).toBeDefined();
    expect(JSON.parse(literal!)).toStrictEqual(EMERGENCY_REVIEW_WORKFLOW_SPEC);
  });
});

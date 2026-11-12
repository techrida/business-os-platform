import { describe, expect, it } from 'vitest';

import { readValues, validateMemo } from './memo-values';

const USER_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const USER_B = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const DEPT = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';

const template = JSON.stringify({
  departmentId: DEPT,
  date: '2026-11-12',
  closing: 'Submitted for your approval.',
  preparedByUserId: USER_A,
  recommenderUserIds: [],
  approvedByUserId: USER_B,
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

describe('readValues', () => {
  it('reads only the title, the body and the template: the form carries no money', () => {
    const values = readValues(
      form({
        title: '  Leave policy  ',
        body: 'Line 1\nLine 2',
        template,
        amount: '99',
        currency: 'USD',
      }),
    );
    expect(values).toEqual({ title: 'Leave policy', body: 'Line 1\nLine 2', template });
    expect(values).not.toHaveProperty('amount');
    expect(values).not.toHaveProperty('currency');
  });

  it('leaves the template out when the form did not send one', () => {
    expect(readValues(form({ title: 't', body: '' })).template).toBeUndefined();
  });
});

describe('validateMemo', () => {
  it('accepts an internal memo with no amount and no currency, and sends none', () => {
    const checked = validateMemo(
      readValues(form({ title: 'Leave policy', body: 'Text', template })),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.data).toMatchObject({ title: 'Leave policy', body: 'Text' });
    expect(checked.data.amount).toBeUndefined();
    expect(checked.data.currency).toBeUndefined();
    expect(checked.data.template?.approvedByUserId).toBe(USER_B);
  });

  it('accepts a title and body alone, so editing an older memo without a template still works', () => {
    expect(validateMemo({ title: 'Old memo', body: '' }).ok).toBe(true);
  });

  it('names the field when the title is empty or the body is too long', () => {
    const empty = validateMemo({ title: '', body: '', template });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.fieldErrors.title).toMatch(/title/i);
    const long = validateMemo({ title: 't', body: 'x'.repeat(10_001), template });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.fieldErrors.body).toMatch(/10,000/);
  });

  it('refuses a template that names the same person twice', () => {
    const twice = JSON.stringify({ ...JSON.parse(template), approvedByUserId: USER_A });
    const checked = validateMemo({ title: 't', body: '', template: twice });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.fieldErrors.template).toBeDefined();
  });

  it('refuses a template that is not JSON', () => {
    expect(validateMemo({ title: 't', body: '', template: '{nope' })).toMatchObject({
      ok: false,
      error: 'Invalid memo fields',
    });
  });
});

import type { CheckPersonAreaRow, CheckPersonReport } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  actionsText,
  assignText,
  changeHref,
  checkHref,
  headerLine,
  personNotice,
  personParam,
  visibleText,
} from './check-model';

const ID = '00000000-0000-4000-8000-0000000000a1';

const person = (over: Partial<CheckPersonReport['person']> = {}): CheckPersonReport['person'] => ({
  id: ID,
  name: 'Asha K.',
  email: 'asha@example.com',
  status: 'active',
  roles: [{ key: 'sales', label: 'Sales' }],
  department: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Sales' },
  level: 'manager',
  ...over,
});

const row = (over: Partial<CheckPersonAreaRow> = {}): CheckPersonAreaRow => ({
  area: 'leads',
  label: 'Leads',
  scope: 'department',
  scopeLabel: 'Their department',
  visibleCount: 48,
  totalCount: 1200,
  actions: [],
  assignableCount: null,
  why: ['Sales role gives Their own.', 'Manager level adds Their department.'],
  ...over,
});

describe('personParam', () => {
  it('takes a well-formed id and ignores anything else', () => {
    expect(personParam(ID)).toBe(ID);
    expect(personParam([ID, 'x'])).toBe(ID);
    expect(personParam('asha')).toBeNull();
    expect(personParam(undefined)).toBeNull();
  });

  it('keeps the chosen person in the address, and clears it when nobody is chosen', () => {
    expect(checkHref(ID)).toBe(`/settings/access/check?person=${ID}`);
    expect(checkHref('')).toBe('/settings/access/check');
  });
});

describe('headerLine', () => {
  it('reads name, roles, level and department, and status', () => {
    expect(headerLine(person())).toBe('Asha K. · Sales · Manager in Sales · Active');
    expect(
      headerLine(
        person({
          roles: [
            { key: 'sales', label: 'Sales' },
            { key: 'marketing', label: 'Marketing' },
          ],
          department: null,
          level: 'staff',
          status: 'inactive',
        }),
      ),
    ).toBe('Asha K. · Sales, Marketing · No department · Disabled');
  });
});

describe('personNotice', () => {
  it('says when the person is disabled or has no roles, and nothing otherwise', () => {
    expect(personNotice(person())).toBeNull();
    expect(personNotice(person({ status: 'inactive' }))).toBe(
      'Asha K. is disabled and cannot sign in. This shows what their roles would allow.',
    );
    expect(personNotice(person({ roles: [] }))).toBe(
      'Asha K. has no roles, so they cannot open anything.',
    );
  });
});

describe('area row wording', () => {
  it('counts what the person can open out of everything', () => {
    expect(visibleText(row())).toBe('48 of 1,200');
  });

  it('lists the actions or says Nothing else', () => {
    expect(actionsText(row())).toBe('Nothing else');
    expect(
      actionsText(
        row({
          actions: [{ permission: 'crm.lead.write', label: 'Create and edit leads', scope: 'own' }],
        }),
      ),
    ).toBe('Create and edit leads');
  });

  it('counts assignable people only where work is assigned', () => {
    expect(assignText(row())).toBeNull();
    expect(assignText(row({ assignableCount: 1 }))).toBe('1 person');
    expect(assignText(row({ assignableCount: 5 }))).toBe('5 people');
  });

  it('links each row to its By area card', () => {
    expect(changeHref(row({ area: 'sales_orders' }))).toBe('/settings/access?area=sales_orders');
  });
});

import { describe, expect, it } from 'vitest';

import { accessCatalogue, MARKETING_DEPT, SALES_DEPT } from '@/test/access-catalogue';

import {
  areaChanges,
  defaultDraft,
  isAreaEdited,
  permissionInfo,
  reachChoices,
  savedDraft,
  splitByAccess,
  staffRoles,
  undoName,
  withControlFrom,
} from './by-area-model';

const catalogue = accessCatalogue();
const area = (key: string) => {
  const found = catalogue.areas.find((a) => a.key === key);
  if (!found) throw new Error(`No area ${key}`);
  return found;
};
const leads = area('leads');

describe('area cards read the catalogue', () => {
  it('lists staff roles only: no Founder and no portal role in an area card', () => {
    const keys = staffRoles(catalogue).map((role) => role.key);
    expect(keys).toEqual(['management', 'sales', 'marketing', 'finance', 'operations_head']);
  });

  it('offers Nothing plus only the scopes the API lists, in the spec order', () => {
    const leadsRead = permissionInfo(catalogue, 'crm.lead.read');
    expect(reachChoices(leadsRead, 'own').map((o) => o.label)).toEqual([
      'Nothing',
      'Only work given to them',
      'Their own',
      'Their department',
      'Everything',
    ]);
    const invoices = permissionInfo(catalogue, 'invoice.read');
    expect(reachChoices(invoices, null).map((o) => o.label)).toEqual([
      'Nothing',
      'Their own',
      'Everything',
    ]);
  });

  it('puts roles with access first and the rest behind the disclosure', () => {
    const split = splitByAccess(staffRoles(catalogue), savedDraft(catalogue, leads));
    expect(split.withAccess.map((r) => r.key)).toEqual(['management', 'sales', 'marketing']);
    expect(split.withoutAccess.map((r) => r.key)).toEqual(['finance', 'operations_head']);
  });

  it('marks an area Edited only when a saved value differs from its default', () => {
    expect(isAreaEdited(catalogue, leads)).toBe(false);
    expect(isAreaEdited(catalogue, area('opportunities'))).toBe(true);
  });
});

describe('staged changes', () => {
  it('sends only what differs, in the contract shape', () => {
    const saved = savedDraft(catalogue, leads);
    expect(areaChanges(catalogue, leads, saved, saved)).toEqual([]);

    const draft = {
      ...saved,
      reach: { ...saved.reach, sales: 'department' as const },
      managers: false,
      assignment: saved.assignment && {
        ...saved.assignment,
        staff: 'self_only' as const,
        handOvers: [
          ...saved.assignment.handOvers,
          { fromDepartmentId: SALES_DEPT, toDepartmentId: MARKETING_DEPT },
        ],
      },
    };
    expect(areaChanges(catalogue, leads, saved, draft)).toEqual([
      { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' },
      { kind: 'levelRule', area: 'leads', managersSeeDepartment: false },
      {
        kind: 'assignment',
        area: 'leads',
        staff: 'self_only',
        handOvers: [
          { fromDepartmentId: MARKETING_DEPT, toDepartmentId: SALES_DEPT },
          { fromDepartmentId: SALES_DEPT, toDepartmentId: MARKETING_DEPT },
        ],
      },
    ]);
  });

  it('removes a grant by sending a null scope', () => {
    const saved = savedDraft(catalogue, leads);
    const draft = { ...saved, reach: { ...saved.reach, marketing: null } };
    expect(areaChanges(catalogue, leads, saved, draft)).toEqual([
      { kind: 'grant', role: 'marketing', permission: 'crm.lead.read', scope: null },
    ]);
  });

  it('builds the single change an undo icon reviews', () => {
    const opportunities = area('opportunities');
    const saved = savedDraft(catalogue, opportunities);
    const reset = withControlFrom(saved, defaultDraft(catalogue, opportunities), {
      type: 'reach',
      role: 'sales',
    });
    expect(areaChanges(catalogue, opportunities, saved, reset)).toEqual([
      { kind: 'grant', role: 'sales', permission: 'crm.opportunity.read', scope: 'own' },
    ]);
  });
});

it('names the undo icon with what it resets and to what (acceptance criterion 4.8)', () => {
  expect(undoName('Sales', 'Leads', 'Their own')).toBe(
    'Reset Sales on Leads to the default: Their own',
  );
});

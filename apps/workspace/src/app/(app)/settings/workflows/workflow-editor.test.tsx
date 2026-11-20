import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { IDLE } from '../action-state';

import { WorkflowEditor } from './workflow-editor';

const id = '11111111-1111-4111-8111-111111111111';
const spec = {
  documentType: 'test_memo',
  steps: [{ id: 'review', kind: 'user', user: id, reason: 'Review' }],
  rules: [],
};
function render(users: { id: string; label: string; name: string; email: null }[] | null) {
  return renderToStaticMarkup(
    <WorkflowEditor
      action={() => Promise.resolve(IDLE)}
      mode="version"
      documentType="test_memo"
      initialSpec={spec}
      submitLabel="Save"
      groupKeys={[]}
      users={users}
    />,
  );
}
it('shows names in person selectors while retaining the internal target', () => {
  const html = render([{ id, label: 'Mina', name: 'Mina', email: null }]);
  expect(html).toContain(`<option value="${id}" selected="">Mina</option>`);
  expect(html).not.toContain(`value="${id}" list=`);
  expect(html).not.toContain('User id');
});
it('retains a missing directory target instead of silently substituting a person', () => {
  const html = render(null);
  expect(html).toContain(
    `<option value="${id}" selected="">Current person (name unavailable)</option>`,
  );
  expect(html).toContain('&quot;user&quot;:&quot;' + id);
});

function renderSpec(initialSpec: unknown, mode: 'create' | 'version' = 'version') {
  return renderToStaticMarkup(
    <WorkflowEditor
      action={() => Promise.resolve(IDLE)}
      mode={mode}
      documentType="test_memo"
      initialSpec={initialSpec}
      submitLabel="Save"
      groupKeys={[]}
      users={null}
    />,
  );
}
it('hides the JSON toggle for a new workflow and for a saved spec the form can show (U23-Q4)', () => {
  for (const html of [renderSpec(undefined, 'create'), renderSpec(spec)]) {
    expect(html).not.toContain('JSON (advanced)');
    expect(html).not.toContain('JSON editor');
  }
});
it('offers the JSON toggle for a saved spec the form cannot show (U23-Q4)', () => {
  const unshowable = {
    ...spec,
    rules: [
      {
        id: 'multi',
        when: {
          all: [
            { field: 'amountNpr', op: 'gt', value: '1' },
            { field: 'x', op: 'eq', value: 'y' },
          ],
        },
        add: { id: 'extra', kind: 'role', role: 'finance', reason: 'Extra' },
        reason: 'Two fields',
      },
    ],
  };
  const html = renderSpec(unshowable);
  expect(html).toContain('JSON (advanced)');
  expect(html).toContain('The form cannot show this spec');
});
// migration 0110's tax_invoice route (F1-Q30): rules only, on the submit facts `fromSchedule` and `kind`.
const taxInvoiceRoute = {
  documentType: 'tax_invoice',
  steps: [],
  rules: [
    {
      id: 'manual-invoice',
      when: { field: 'fromSchedule', op: 'eq', value: false },
      add: { id: 'accountant', kind: 'role', role: 'accountant', reason: 'Accountant checks' },
      position: 'end',
      reason: 'Accountant check: a manual invoice',
    },
    {
      id: 'finance-approves',
      when: { field: 'kind', op: 'eq', value: 'tax_invoice' },
      add: { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
      position: 'end',
      reason: 'Finance approves every tax invoice',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};
it('opens the tax invoice route in the form without the JSON toggle (U23-Q4)', () => {
  const html = renderSpec(taxInvoiceRoute);
  expect(html).not.toContain('JSON (advanced)');
  expect(html).not.toContain('The form cannot show this spec');
  expect(html).toContain(
    '<option value="false" selected="">is not from an approved billing schedule</option>',
  );
  expect(html).toMatch(
    /<input[^>]*readOnly=""[^>]*value="tax_invoice"|<input[^>]*value="tax_invoice"[^>]*readOnly=""/,
  );
  // No amount field or amount wording on a fact rule.
  expect(html).not.toContain('Amount (NPR)');
  expect(html).not.toContain('When amountNpr');
  // The saved spec goes out unchanged, false as a boolean.
  expect(html).toContain('&quot;value&quot;:false');
});

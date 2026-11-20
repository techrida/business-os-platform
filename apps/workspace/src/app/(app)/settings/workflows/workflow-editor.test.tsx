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

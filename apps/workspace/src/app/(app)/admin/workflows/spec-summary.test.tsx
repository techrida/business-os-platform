import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SpecSummary } from './spec-summary';
const id = '11111111-1111-4111-8111-111111111111';
const spec = {
  documentType: 'test_memo',
  steps: [{ id: 'review', kind: 'user', user: id, reason: 'Review' }],
  rules: [],
};
it('names approvers in published workflow summaries and uses an unavailable state when missing', () => {
  const named = renderToStaticMarkup(<SpecSummary spec={spec} people={{ [id]: 'Mina' }} />);
  expect(named).toContain('Person: Mina');
  expect(named).not.toContain(id);
  const missing = renderToStaticMarkup(<SpecSummary spec={spec} />);
  expect(missing).toContain('Name unavailable');
  expect(missing).not.toContain(id);
});

// @vitest-environment jsdom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { mountForm, paste, typeKeys } from '@/test/form-interactions';

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

// The editor posts only the hidden `spec` JSON, built from its state; the number boxes post nothing.
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

const amountRoute = {
  ...spec,
  rules: [
    {
      id: 'big',
      when: { field: 'amountNpr', op: 'gt', value: '100' },
      add: { id: 'founder', kind: 'role', role: 'founder', reason: 'Founder approves' },
      position: 'end',
      reason: 'Large amounts',
    },
  ],
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

async function mountEditor(initialSpec: unknown) {
  mounted = await mountForm(
    <WorkflowEditor
      action={() => Promise.resolve(IDLE)}
      mode="version"
      documentType="test_memo"
      initialSpec={initialSpec}
      submitLabel="Save"
      groupKeys={[]}
      users={null}
    />,
  );
  const { container } = mounted;
  const box = (label: string) => {
    const labelEl = [...container.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === label,
    );
    const input = labelEl ? container.querySelector(`#${CSS.escape(labelEl.htmlFor)}`) : null;
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing box ${label}`);
    return input;
  };
  const posted = () => {
    const text = new FormData(container.querySelector('form')!).get('spec');
    expect(typeof text === 'string' && text !== '').toBe(true);
    return JSON.parse(text as string) as {
      rules: { when: { value: unknown } }[];
      sla: { remindAfterHours: number; escalateAfterHours: number };
    };
  };
  return { container, box, posted };
}

async function selectAll(input: HTMLInputElement) {
  await act(() => {
    input.focus();
    input.setSelectionRange(0, input.value.length);
    return Promise.resolve();
  });
}

it('saves the stored amount unchanged until the admin edits it', async () => {
  const { box, posted } = await mountEditor(amountRoute);
  expect(box('Amount (NPR)').value).toBe('100.00');
  expect(posted().rules[0]!.when.value).toBe('100');
  expect(posted().sla).toMatchObject({ remindAfterHours: 24, escalateAfterHours: 72 });
});

it('refuses a minus in the amount, so the saved amount is never negative', async () => {
  const { container, box, posted } = await mountEditor(amountRoute);
  const amount = box('Amount (NPR)');
  await selectAll(amount);
  await typeKeys(amount, '7');
  expect(amount.value).toBe('7');
  await typeKeys(amount, '-');
  expect(amount.value).toBe('7');
  expect(posted().rules[0]!.when.value).toBe('7');

  await selectAll(amount);
  await typeKeys(amount, '-5');
  expect(amount.value).toBe('5');
  expect(posted().rules[0]!.when.value).toBe('5');

  await selectAll(amount);
  await paste(amount, '-5');
  expect(amount.value).toBe('5');
  expect(posted().rules[0]!.when.value).toBe('5');
  expect(container.querySelector('input[name="spec"]')!.getAttribute('value')).not.toContain('-5');
});

it('groups the amount in lakh style and saves the plain number', async () => {
  const { box, posted } = await mountEditor(amountRoute);
  const amount = box('Amount (NPR)');
  await selectAll(amount);
  await typeKeys(amount, '1250000');
  expect(amount.value).toBe('12,50,000');
  expect(posted().rules[0]!.when.value).toBe('1250000');
  // Leaving the box (as clicking Save does) pads to two decimals; the saved amount stays positive.
  await act(() => Promise.resolve(amount.blur()));
  expect(amount.value).toBe('12,50,000.00');
  expect(posted().rules[0]!.when.value).toBe('1250000.00');
});

it('takes whole hours only in the reminder and escalation boxes', async () => {
  const { box, posted } = await mountEditor(amountRoute);
  const remind = box('Remind after (hours)');
  const escalate = box('Escalate after (hours)');
  expect(remind.inputMode).toBe('numeric');
  expect(escalate.inputMode).toBe('numeric');

  await selectAll(remind);
  await typeKeys(remind, '-1.5');
  expect(remind.value).toBe('15');
  await selectAll(escalate);
  await typeKeys(escalate, '4-8.');
  expect(escalate.value).toBe('48');
  expect(posted().sla).toMatchObject({ remindAfterHours: 15, escalateAfterHours: 48 });
});

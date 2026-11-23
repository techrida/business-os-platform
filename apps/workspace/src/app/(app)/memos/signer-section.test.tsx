// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { SignerSection } from './signer-section';

const ME = '00000000-0000-4000-8000-000000000001';
const people = [
  { userId: ME, name: 'Dev Sales', jobTitle: null, department: 'Sales', canApprove: false },
];

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted.unmount();
  document.body.innerHTML = '';
});

it('shows the preparer as name and role in the field, like the list row (BOS-UI-001)', async () => {
  mounted = await mountForm(
    <SignerSection
      people={people}
      currentUserId={ME}
      recommenders={['', '']}
      onRecommenders={() => undefined}
      approvedBy=""
      onApprovedBy={() => undefined}
    />,
  );
  const box = mounted.container.querySelector<HTMLInputElement>(
    'input[role="combobox"][aria-label="Prepared by"]',
  )!;
  expect(box.value).toBe('Dev Sales Sales');
});

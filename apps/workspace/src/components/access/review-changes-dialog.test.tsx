// @vitest-environment jsdom
import type {
  AccessChange,
  AccessPreviewResponse,
  AccessWarning,
  AccessWarningCode,
} from '@bos/contracts';
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: toasts }));

import {
  ReviewChangesDialog,
  type ReviewChangesDialogProps,
  type ReviewPreviewResult,
  type ReviewSaveResult,
} from './review-changes-dialog';

type SaveInput = { acknowledged: AccessWarningCode[]; note: string };

const CHANGES: AccessChange[] = [
  { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' },
];

function preview(warnings: AccessWarning[] = []): AccessPreviewResponse {
  return {
    applied: [
      { label: 'Sales · See leads', from: 'Their own', to: 'Their department' },
      {
        label: 'Sales · See opportunities',
        from: 'Their own',
        to: 'Their department',
        serverAdded: true,
      },
    ],
    impact: {
      widened: { people: 6, sample: ['Asha K.', 'Bibek R.', 'Chandra T.'] },
      narrowed: { people: 0, sample: [] },
      unchanged: 9,
    },
    warnings,
    summaries: {},
    assignmentSummaries: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

/** The dialog with a real open state and an opener button, as a screen uses it. */
function Harness(props: Partial<ReviewChangesDialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Review changes
      </button>
      <ReviewChangesDialog
        open={open}
        onOpenChange={setOpen}
        title="Review changes to Leads"
        changes={CHANGES}
        expectedRevision="7"
        runPreview={() => Promise.resolve({ ok: true, preview: preview() })}
        runSave={() => Promise.resolve({ ok: true })}
        onSaved={() => undefined}
        onStale={() => undefined}
        {...props}
      />
    </>
  );
}

async function openDialog(props: Partial<ReviewChangesDialogProps>) {
  mounted = await mountForm(<Harness {...props} />);
  const opener = button('Review changes');
  opener.focus();
  await click(opener);
  await flush();
  return opener;
}

it('saves only after a dry run succeeds and every confirm box is ticked', async () => {
  const dryRun = deferred<ReviewPreviewResult>();
  const runPreview = vi.fn((_changes: AccessChange[]) => dryRun.promise);
  const runSave = vi.fn((_input: SaveInput) => Promise.resolve<ReviewSaveResult>({ ok: true }));
  const onSaved = vi.fn();
  await openDialog({ runPreview, runSave, onSaved });

  expect(runPreview).toHaveBeenCalledWith(CHANGES);
  expect(button('Save changes').disabled).toBe(true);

  const warning: AccessWarning = {
    code: 'W5',
    severity: 'confirm',
    message: '12 people will see every invoice.',
  };
  await act(async () => {
    dryRun.resolve({ ok: true, preview: preview([warning]) });
    await dryRun.promise;
  });
  const body = document.querySelector('[role="dialog"]')?.textContent ?? '';
  expect(body).toContain('Sales · See leads: Their own');
  expect(body).toContain('also changes');
  expect(body).toContain('6 people will see more: Asha K., Bibek R., Chandra T. and 3 others.');
  expect(body).toContain('No one will see less.');
  expect(button('Save changes').disabled).toBe(true);

  const box = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]');
  await click(box);
  expect(button('Save changes').disabled).toBe(false);

  await click(button('Save changes'));
  await flush();
  expect(runSave).toHaveBeenCalledWith({ acknowledged: ['W5'], note: '' });
  expect(toasts.success).toHaveBeenCalledWith('Access saved. It applies within a few seconds.');
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('cannot save while a blocked warning applies, even with every confirm box ticked', async () => {
  const warnings: AccessWarning[] = [
    { code: 'W1', severity: 'blocked', message: 'Founders always have full access.' },
    { code: 'W5', severity: 'confirm', message: '12 people will see every invoice.' },
  ];
  const runSave = vi.fn((_input: SaveInput) => Promise.resolve<ReviewSaveResult>({ ok: true }));
  await openDialog({
    runPreview: () => Promise.resolve({ ok: true, preview: preview(warnings) }),
    runSave,
  });

  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Founders always have full access.',
  );
  await click(document.querySelector('[role="dialog"] input[type="checkbox"]'));
  expect(button('Save changes').disabled).toBe(true);
  await click(button('Save changes'));
  expect(runSave).not.toHaveBeenCalled();
});

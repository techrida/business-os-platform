// @vitest-environment jsdom
// Pressing Escape in a milestone's amount box puts back the percent the row had before the amount
// edit. That percent goes back as a plain decimal (60, not 60.0000), like every other write path.
import { act, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';

import type { MilestoneValues } from './model';
import { ScheduleSection, type AmountDraft } from './schedule-section';

function Harness({ initial }: { initial: MilestoneValues[] }) {
  const [milestones, setMilestones] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, AmountDraft>>({});
  return (
    <>
      <span data-testid="held-percent">{milestones[0]?.percent}</span>
      <ScheduleSection
        milestones={milestones}
        currency="NPR"
        total="1000.00"
        amountDrafts={drafts}
        disabled={false}
        showScheduleErrors={false}
        errors={{}}
        onChange={(key, patch) =>
          setMilestones((current) => current.map((m) => (m.key === key ? { ...m, ...patch } : m)))
        }
        onAmountDraft={(key, draft) =>
          setDrafts((current) => {
            const next = { ...current };
            if (draft) next[key] = draft;
            else delete next[key];
            return next;
          })
        }
        onAdd={() => {}}
        onRemove={() => {}}
      />
    </>
  );
}

/** The percent the parent holds for the row, as the builder would save it. */
function heldPercent(container: HTMLElement): string | null | undefined {
  return container.querySelector('[data-testid="held-percent"]')?.textContent;
}

function amountBox(container: HTMLElement): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === 'Amount (NPR)',
  );
  const box = label ? container.querySelector(`#${CSS.escape(label.htmlFor)}`) : null;
  if (!(box instanceof HTMLInputElement)) throw new Error('Missing amount box');
  return box;
}

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

describe('ScheduleSection amount Escape', () => {
  it('restores the earlier percent as a plain decimal', async () => {
    const mounted = await mountForm(
      <Harness
        initial={[{ key: 'm1', label: 'Advance', percent: '60.0000', dueDescription: '' }]}
      />,
    );
    unmount = mounted.unmount;
    const box = amountBox(mounted.container);
    expect(box.value).toBe('600.00');

    await act(() => Promise.resolve(box.focus()));
    await fill(box, '500');
    expect(heldPercent(mounted.container)).toBe('50');

    await act(() =>
      Promise.resolve(
        box.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      ),
    );

    expect(heldPercent(mounted.container)).toBe('60');
    expect(amountBox(mounted.container).value).toBe('600.00');
  });
});

// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { ActivityTypeButtons, type ActivityTypeKind } from './activity-type-buttons';
import { LOG_ACTIVITY_KINDS, SCHEDULE_ACTIVITY_KINDS } from './forms';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

function Picker({
  kinds = LOG_ACTIVITY_KINDS,
  initial = 'call',
  onChange,
}: {
  kinds?: readonly ActivityTypeKind[];
  initial?: ActivityTypeKind;
  onChange?: (kind: ActivityTypeKind) => void;
}) {
  const [value, setValue] = useState<ActivityTypeKind>(initial);
  return (
    <form>
      <ActivityTypeButtons
        kinds={kinds}
        value={value}
        name="kind"
        label="Type"
        onChange={(kind) => {
          setValue(kind);
          onChange?.(kind);
        }}
      />
    </form>
  );
}

const radios = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true');
const posted = () => new FormData(document.querySelector('form')!).get('kind');

async function press(key: string) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) throw new Error('Nothing focused');
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return Promise.resolve();
  });
}

it('is a labelled radio group of native buttons with one tab stop on the selected kind', async () => {
  await mountForm(<Picker initial="meeting" />);
  const group = document.querySelector('[role="radiogroup"]');
  const labelId = group?.getAttribute('aria-labelledby');
  expect(document.getElementById(labelId!)?.textContent).toBe('Type');
  expect(radios().map((r) => r.textContent)).toEqual(['Call', 'Meeting', 'Email', 'Note']);
  expect(radios().every((r) => r.type === 'button')).toBe(true);
  expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual([
    'false',
    'true',
    'false',
    'false',
  ]);
  expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
  expect(posted()).toBe('meeting');
});

it('moves and selects with the arrow keys, wrapping at both ends, and jumps with Home and End', async () => {
  const onChange = vi.fn<(kind: ActivityTypeKind) => void>();
  await mountForm(<Picker onChange={onChange} />);
  radios()[0]!.focus();

  await press('ArrowRight');
  expect(checked()?.textContent).toBe('Meeting');
  expect(document.activeElement).toBe(checked());
  expect(posted()).toBe('meeting');

  await press('ArrowDown');
  expect(checked()?.textContent).toBe('Email');

  await press('End');
  expect(checked()?.textContent).toBe('Note');
  await press('ArrowRight');
  expect(checked()?.textContent).toBe('Call');
  await press('ArrowLeft');
  expect(checked()?.textContent).toBe('Note');
  await press('Home');
  expect(checked()?.textContent).toBe('Call');
  await press('ArrowUp');
  expect(checked()?.textContent).toBe('Note');

  expect(document.activeElement).toBe(checked());
  expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0]);
  expect(onChange.mock.calls.map(([k]) => k)).toEqual([
    'meeting',
    'email',
    'note',
    'call',
    'note',
    'call',
    'note',
  ]);
  expect(posted()).toBe('note');
});

it('ignores other keys and selects on click', async () => {
  await mountForm(<Picker />);
  radios()[0]!.focus();
  await press('a');
  expect(checked()?.textContent).toBe('Call');

  await click(radios()[2]!);
  expect(checked()?.textContent).toBe('Email');
  expect(posted()).toBe('email');
});

it('offers only call, meeting and email when scheduling', async () => {
  await mountForm(<Picker kinds={SCHEDULE_ACTIVITY_KINDS} initial="email" />);
  expect(radios().map((r) => r.textContent)).toEqual(['Call', 'Meeting', 'Email']);
  radios()[2]!.focus();
  await press('ArrowRight');
  expect(checked()?.textContent).toBe('Call');
});

it('links an error to the group and marks it invalid', async () => {
  await mountForm(
    <ActivityTypeButtons
      kinds={LOG_ACTIVITY_KINDS}
      value="call"
      name="kind"
      label="Type"
      error="Choose call, meeting, email or note."
      onChange={() => undefined}
    />,
  );
  const group = document.querySelector('[role="radiogroup"]');
  expect(group?.getAttribute('aria-invalid')).toBe('true');
  const errorId = group?.getAttribute('aria-describedby');
  expect(document.getElementById(errorId!)?.textContent).toBe(
    'Choose call, meeting, email or note.',
  );
});

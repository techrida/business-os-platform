// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { fill } from '@/test/form-interactions';

import { SearchInput } from './search-input';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const input = () => container.querySelector<HTMLInputElement>('input[type="search"]')!;
const clearButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');

function Controlled() {
  const [q, setQ] = useState('');
  return (
    <>
      <SearchInput aria-label="Find" value={q} onChange={(e) => setQ(e.target.value)} />
      <output>{q}</output>
    </>
  );
}

it('shows the clear button only while there is text, and clears a controlled field', async () => {
  await act(() => Promise.resolve(root.render(<Controlled />)));
  expect(clearButton()).toBeNull();

  await fill(input(), 'acme');
  expect(container.querySelector('output')!.textContent).toBe('acme');
  const button = clearButton();
  expect(button).not.toBeNull();
  expect(button!.type).toBe('button');

  await act(() => Promise.resolve(button!.click()));
  expect(container.querySelector('output')!.textContent).toBe('');
  expect(input().value).toBe('');
  expect(clearButton()).toBeNull();
  expect(document.activeElement).toBe(input());
});

it('clears an uncontrolled field and returns focus to it', async () => {
  await act(() =>
    Promise.resolve(root.render(<SearchInput aria-label="Find" name="q" defaultValue="vendor" />)),
  );
  expect(clearButton()).not.toBeNull();
  await act(() => Promise.resolve(clearButton()!.click()));
  expect(input().value).toBe('');
  expect(clearButton()).toBeNull();
  expect(document.activeElement).toBe(input());
});

it('has no clear button on a disabled or read-only field', async () => {
  await act(() =>
    Promise.resolve(
      root.render(<SearchInput aria-label="Find" defaultValue="x" disabled readOnly />),
    ),
  );
  expect(clearButton()).toBeNull();
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { Table, Td, Th } from './table';

/** Header widths jsdom cannot lay out, keyed by the header's text. */
const WIDTHS: Record<string, number> = { Status: 120, 'Valid until': 110, Action: 88 };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return { width: WIDTHS[this.textContent] ?? 0 } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function List({ pinnedValidUntil = true }: { pinnedValidUntil?: boolean }) {
  return (
    <Table caption="Quotations">
      <thead>
        <tr>
          <Th>Quotation</Th>
          <Th pinned>Status</Th>
          <Th pinned={pinnedValidUntil}>Valid until</Th>
          <Th pinned>Action</Th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <Td>QT-0001</Td>
          <Td pinned>Sent</Td>
          <Td pinned={pinnedValidUntil}>01 Dec 2026</Td>
          <Td pinned>View</Td>
        </tr>
      </tbody>
    </Table>
  );
}

it('marks only the pinned header and body cells', () => {
  const html = renderToStaticMarkup(<List />);
  expect(html).toContain('<th scope="col">Quotation</th>');
  expect(html).toContain('<td>QT-0001</td>');
  expect(html.match(/<th scope="col" data-pinned="">/g)).toHaveLength(3);
  expect(html.match(/<td data-pinned="">/g)).toHaveLength(3);
});

it('gives each trailing pinned column the running width of the columns after it', async () => {
  const view = await mountForm(<List />);
  const wrap = view.container.querySelector<HTMLElement>('[role="region"]');
  expect(wrap?.hasAttribute('data-pinned-ready')).toBe(true);
  expect(wrap?.style.getPropertyValue('--table-pin-end-1')).toBe('0px');
  expect(wrap?.style.getPropertyValue('--table-pin-end-2')).toBe('88px');
  expect(wrap?.style.getPropertyValue('--table-pin-end-3')).toBe('198px');
  await view.unmount();
});

it('stops at the first unpinned column from the end', async () => {
  const view = await mountForm(<List pinnedValidUntil={false} />);
  const wrap = view.container.querySelector<HTMLElement>('[role="region"]');
  expect(wrap?.style.getPropertyValue('--table-pin-end-1')).toBe('0px');
  expect(wrap?.style.getPropertyValue('--table-pin-end-2')).toBe('');
  await view.unmount();
});

it('leaves a table without pinned columns alone', async () => {
  const view = await mountForm(
    <Table caption="Plain">
      <thead>
        <tr>
          <Th>Name</Th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <Td>Row</Td>
        </tr>
      </tbody>
    </Table>,
  );
  const wrap = view.container.querySelector<HTMLElement>('[role="region"]');
  expect(wrap?.hasAttribute('data-pinned-ready')).toBe(false);
  expect(wrap?.getAttribute('style')).toBeNull();
  await view.unmount();
});

it('makes pinned cells sticky in the shared table styles, not only shaded', () => {
  const css = readFileSync(join(process.cwd(), 'src/components/ui/table.module.css'), 'utf8');
  const sticky =
    /\.table \[data-pinned\]:last-child,\s*\.wrap\[data-pinned-ready\] \.table \[data-pinned\] \{[^}]*position: sticky;/;
  expect(css).toMatch(sticky);
  for (const n of [2, 3, 4]) {
    expect(css).toContain(
      `.wrap[data-pinned-ready] .table [data-pinned]:nth-last-child(${n}) {\n  inset-inline-end: var(--table-pin-end-${n}, 0);`,
    );
  }
});

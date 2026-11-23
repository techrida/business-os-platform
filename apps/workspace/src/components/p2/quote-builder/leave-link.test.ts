import { expect, it } from 'vitest';

import { leaveAction } from './leave-link';

const HERE = 'https://app.example.test/quotations/q1/edit?saved=1';

it('follows another page of the app softly', () => {
  expect(leaveAction('https://app.example.test/leads?x=1#top', HERE)).toEqual({
    kind: 'push',
    path: '/leads?x=1#top',
  });
});

it('reloads for the link back to this page (the totals panel "Reload the page" link)', () => {
  expect(leaveAction(HERE, HERE)).toEqual({ kind: 'assign', href: HERE });
});

it('does a full load for another site', () => {
  expect(leaveAction('https://other.example.test/x', HERE)).toEqual({
    kind: 'assign',
    href: 'https://other.example.test/x',
  });
});

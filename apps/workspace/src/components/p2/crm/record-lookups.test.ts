import { beforeEach, expect, it, vi } from 'vitest';

import { listContacts, listCustomers } from '@/components/p2/customers/api';
import { requireStaffSession } from '@/lib/bff';

import { loadConversionContacts, searchConversionCustomers } from './record-lookups';

vi.mock('@/components/p2/customers/api', () => ({ listCustomers: vi.fn(), listContacts: vi.fn() }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
const session = { accessToken: 'test-only-token' };
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireStaffSession).mockResolvedValue(session as never);
});
it('searches through the authenticated API and returns only business fields', async () => {
  vi.mocked(listCustomers).mockResolvedValue({
    items: [
      { id, legalName: 'Acme', number: 'CUS-01', panVatNo: '601234567', ownerUserId: 'private' },
      { id: 'merged', legalName: 'Acme old', number: 'CUS-02', panVatNo: null, mergedIntoId: id },
    ],
    total: 2,
  } as never);
  expect(await searchConversionCustomers(' Acme ')).toEqual({
    customers: [{ id, name: 'Acme', number: 'CUS-01', pan: '601234567' }],
    panMatches: [],
    error: '',
  });
  expect(listCustomers).toHaveBeenCalledWith(session, { q: 'Acme', limit: 20 });
});
it('a PAN lookup keeps only customers with the SAME number once spaces and dashes are removed (not a substring, not a merged record)', async () => {
  const mk = (n: string, pan: string | null, merged: string | null = null) => ({
    id: n.repeat(8).slice(0, 8) + id.slice(8),
    legalName: `Co ${n}`,
    number: `CUS-${n}`,
    panVatNo: pan,
    mergedIntoId: merged,
  });
  vi.mocked(listCustomers).mockResolvedValue({
    items: [
      mk('1', '601234567'),
      mk('2', '6012345678'),
      mk('3', '601-234-567'),
      mk('4', null),
      mk('5', '601234567', id),
    ],
    total: 5,
  } as never);
  const found = await searchConversionCustomers('', '601 234 567');
  expect(found.panMatches.map((c) => c.number)).toEqual(['CUS-1', 'CUS-3']);
  expect(found.customers).toEqual([]);
  expect(listCustomers).toHaveBeenCalledTimes(1);
  expect(listCustomers).toHaveBeenCalledWith(session, { q: '601234567', limit: 20 });
});
it('does not call the API without a staff session', async () => {
  vi.mocked(requireStaffSession).mockRejectedValue(new Error('sign in'));
  await expect(searchConversionCustomers('Acme')).rejects.toThrow('sign in');
  expect(listCustomers).not.toHaveBeenCalled();
});
it('keeps contact reads scoped to the chosen customer and caller', async () => {
  vi.mocked(listContacts).mockResolvedValue({
    items: [{ id, fullName: 'Mina', email: 'private' }],
    total: 1,
  } as never);
  expect(await loadConversionContacts(id)).toEqual({
    options: [{ id, label: 'Mina', disabled: false }],
    error: '',
  });
  expect(listContacts).toHaveBeenCalledWith(session, id);
  expect((await loadConversionContacts('../users')).error).not.toBe('');
  expect(listContacts).toHaveBeenCalledTimes(1);
});
it('shows a contact without an email but does not let it be chosen (its quotations could not be sent)', async () => {
  vi.mocked(listContacts).mockResolvedValue({
    items: [{ id, fullName: 'Ravi', email: null }],
    total: 1,
  } as never);
  expect(await loadConversionContacts(id)).toEqual({
    options: [{ id, label: 'Ravi (no email address)', disabled: true }],
    error: '',
  });
});
it('reports denied or failed lookups without leaking API errors or granting access', async () => {
  vi.mocked(listCustomers).mockRejectedValue(new Error('secret backend details'));
  vi.mocked(listContacts).mockRejectedValue(new Error('secret backend details'));
  const people = await searchConversionCustomers('Acme', '601234567');
  expect(people.customers).toEqual([]);
  expect(people.panMatches).toEqual([]);
  const contacts = await loadConversionContacts(id);
  expect(contacts.options).toEqual([]);
  for (const result of [people, contacts]) {
    expect(result.error).not.toBe('');
    expect(result.error).not.toContain('secret');
  }
});

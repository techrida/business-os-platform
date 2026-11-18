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
it('searches through the authenticated API and returns only IDs and business labels', async () => {
  vi.mocked(listCustomers).mockResolvedValue({
    items: [{ id, legalName: 'Acme', number: 'CUS-01', ownerUserId: 'private' }],
    total: 1,
  } as never);
  expect(await searchConversionCustomers(' Acme ')).toEqual({
    options: [{ id, label: 'Acme · CUS-01' }],
    error: '',
  });
  expect(listCustomers).toHaveBeenCalledWith(session, { q: 'Acme', limit: 20 });
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
  for (const result of [
    await searchConversionCustomers('Acme'),
    await loadConversionContacts(id),
  ]) {
    expect(result.options).toEqual([]);
    expect(result.error).not.toBe('');
    expect(result.error).not.toContain('secret');
  }
});

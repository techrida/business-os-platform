// The bell's list route. The approvals engine stores a draft reference such as `Draft tax_invoice 242d0b45`
// until the invoice is numbered at issue; the bell used to show that raw key. The strings below are the
// exact shapes the producers write (approvals/requests.service.ts, invoices/invoice-approval.service.ts).
import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));

const session = { sub: 'user-1' } as unknown as Session;
const routeSessionCall = vi.fn((_options?: unknown) => session);
vi.mock('@/lib/bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bff')>()),
  routeSession: (options?: unknown) => Promise.resolve(routeSessionCall(options)),
}));

const listNotifications = vi.fn();
vi.mock('@/lib/api-kernel', () => ({
  listNotifications: (...args: unknown[]) => listNotifications(...args) as unknown,
}));

const { GET } = await import('./route');

const row = (id: string, title: string, body: string) => ({
  id,
  title,
  body,
  link: '/inbox/33333333-3333-4333-8333-333333333333',
  readAt: null,
  createdAt: '2026-11-20T06:00:00.000Z',
});

describe('GET /api/notifications', () => {
  it('reads the session without sliding it: the bell poll must not keep a tab signed in', async () => {
    listNotifications.mockResolvedValue([]);
    await GET();
    expect(routeSessionCall).toHaveBeenCalledWith({ slide: false });
  });

  it('shows document types as words, not internal keys', async () => {
    listNotifications.mockResolvedValue([
      row(
        'n1',
        'Approval needed: Draft tax_invoice 242d0b45',
        'Tax invoice for Himal Traders (NPR 1130.00)',
      ),
      row(
        'n2',
        'Draft credit_note 0a1b2c3d was approved',
        'Draft credit_note 0a1b2c3d was approved.',
      ),
      row('n3', 'Reminder: Draft debit_note 7d92d5bf awaits you', 'Debit note for Himal Traders'),
      row('n4', 'Approval needed: QT-2026-0007', 'Quotation for Himal Traders'),
    ]);

    const res = await GET();
    const { items } = (await res.json()) as { items: { title: string; body: string }[] };

    expect(items.map((i) => i.title)).toEqual([
      'Approval needed: tax invoice draft',
      'Credit note draft was approved',
      'Reminder: debit note draft awaits you',
      'Approval needed: QT-2026-0007',
    ]);
    expect(items[1]!.body).toBe('Credit note draft was approved.');
    expect(items[0]!.body).toBe('Tax invoice for Himal Traders (NPR 1130.00)');
    for (const item of items) expect(`${item.title} ${item.body}`).not.toMatch(/_/);
  });
});

// The roles matrix lists `quotation.cost.read` (D29) in the quotation group, says in plain words what it shows, and
// marks the roles that hold it by default. The page renders for real from the contracts catalog; only the session
// and the user list are faked.
// Run with: pnpm --filter @bos/workspace exec vitest run 'src/app/(app)/settings/roles/page.test.tsx'
import { DEFAULT_ROLE_PERMISSIONS, ROLE_KEYS } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/session', () => ({
  getSession: () =>
    Promise.resolve({ accessToken: 't', orgKind: 'staff', roles: ['founder'] } as Session),
}));
vi.mock('@/lib/api-admin', () => ({
  listUsers: vi.fn(() => Promise.resolve({ items: [], nextAfter: null })),
}));

const { default: RolesPage } = await import('./page');

/** The `<tbody>` of one permission group, by its group heading. */
function group(html: string, area: string): string {
  const start = html.indexOf(`>${area}</th>`);
  expect(start, `group ${area}`).toBeGreaterThan(-1);
  const end = html.indexOf('</tbody>', start);
  return html.slice(start, end);
}

/** The `<tr>` of one permission. */
function row(html: string, permission: string): string {
  const at = html.indexOf(`>${permission}</span>`);
  expect(at, `row ${permission}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
}

describe('settings roles matrix: quotation.cost.read', () => {
  it('is a row of the quotation group with a plain-language note', async () => {
    const html = renderToStaticMarkup(await RolesPage());
    const quotation = group(html, 'quotation');
    expect(quotation).toContain('>quotation.cost.read</span>');
    expect(row(html, 'quotation.cost.read')).toContain(
      'Sees unit cost, internal cost total and margin on quotations.',
    );
  });

  it('marks exactly the roles that hold it by default', async () => {
    const html = renderToStaticMarkup(await RolesPage());
    const cells = row(html, 'quotation.cost.read').split('<td').slice(1);
    expect(cells).toHaveLength(ROLE_KEYS.length);
    ROLE_KEYS.forEach((role, i) => {
      const held = DEFAULT_ROLE_PERMISSIONS[role]['quotation.cost.read'] !== undefined;
      expect(cells[i]!.includes('No access'), role).toBe(!held);
    });
    // Founder, management, finance, accountant and sales hold it; the count guards against an empty catalog.
    expect(ROLE_KEYS.filter((r) => DEFAULT_ROLE_PERMISSIONS[r]['quotation.cost.read'])).toEqual(
      expect.arrayContaining(['founder', 'sales', 'management']),
    );
  });
});

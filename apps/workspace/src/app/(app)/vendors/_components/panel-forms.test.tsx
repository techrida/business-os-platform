import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { lifecycleOptions } from '../_lib/model';
import { LifecycleForm } from './panel-forms';

vi.mock('../actions', () => ({
  addContactAction: vi.fn(),
  decideBankAction: vi.fn(),
  grantPortalAction: vi.fn(),
  lifecycleAction: vi.fn(),
  proposeBankAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const render = (status: 'approved' | 'blocked', command: 'block' | 'archive') => {
  const option = lifecycleOptions(status, { write: true, activate: true }).find(
    (candidate) => candidate.command === command,
  );
  if (!option) throw new Error(`Missing lifecycle option ${command}`);
  return renderToStaticMarkup(
    <LifecycleForm vendorId="vendor-id" option={option} idempotencyKey="request-key" />,
  );
};

describe('vendor lifecycle confirmation', () => {
  it.each([
    ['approved', 'block', 'Block vendor'],
    ['blocked', 'archive', 'Archive vendor'],
  ] as const)(
    'confirms %s to %s with the required reason inside a labelled dialog',
    (status, command, label) => {
      const html = render(status, command);
      const dialog = html.match(/<dialog\b[^>]*>[\s\S]*?<\/dialog>/)?.[0];
      expect(dialog).toBeDefined();
      expect(dialog).toMatch(/aria-labelledby="[^"]+"/);
      expect(dialog).toMatch(/aria-describedby="[^"]+"/);
      expect(dialog).toContain('<h2');
      expect(dialog).toContain(`${label}?`);
      expect(dialog).toMatch(/<textarea[^>]*name="reason"[^>]*required=""/);
      expect(dialog).toContain('name="command"');
      expect(dialog).toContain(`value="${command}"`);
      expect(dialog).toContain('name="idempotencyKey"');
      expect(dialog).toContain('Cancel');
      expect(dialog).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*>${label}</button>`));
      const beforeDialog = html.split('<dialog')[0];
      expect(beforeDialog).toContain(label);
      expect(beforeDialog).not.toContain('type="submit"');
    },
  );
});

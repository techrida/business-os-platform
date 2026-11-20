import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailDeliveryDto } from '@bos/contracts';

import type { Session } from '@/lib/session';

// Settings > Email delivery (F1-Q15): the log lists failed and bounced emails and offers Resend to a person
// whose live grants hold email_delivery.resend. The page and the action read live grants, not role defaults.

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/email-delivery',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe =
  vi.fn<(token: string) => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: (session: { accessToken: string }) => getMe(session.accessToken),
}));
const api = vi.hoisted(() => ({ listEmailDeliveries: vi.fn(), resendEmail: vi.fn() }));
vi.mock('@/lib/api-email-delivery', () => api);

const { default: EmailDeliveryPage } = await import('./page');
const { resendEmailAction } = await import('./actions');
const { ApiError } = await import('@/lib/api');

const ID = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b';

function item(over: Partial<EmailDeliveryDto> = {}): EmailDeliveryDto {
  return {
    id: ID,
    template: 'approval.pending',
    recipient: 'asha@example.test',
    subject: 'MEMO-2082/83-00001 needs your approval',
    state: 'failed',
    attempts: 5,
    resendCount: 0,
    lastError: '550 mailbox unavailable',
    createdAt: '2026-11-20T04:00:00.000Z',
    sentAt: null,
    canResend: true,
    ...over,
  };
}

const grants = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(
    (await EmailDeliveryPage({ searchParams: Promise.resolve(params) })) as ReactElement,
  );

const text = (html: string) => html.replace(/<[^>]*>/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ accessToken: 't', orgKind: 'staff', roles: ['sales'] } as Session);
  api.listEmailDeliveries.mockResolvedValue({ items: [item()], nextBefore: null });
});

describe('the email delivery page', () => {
  it('lists failed emails with the reason and offers Resend to a person who may resend', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read', 'email_delivery.resend'));
    const html = await render();

    expect(api.listEmailDeliveries).toHaveBeenCalledWith(expect.anything(), {
      filter: 'failed',
      before: undefined,
    });
    expect(text(html)).toContain('MEMO-2082/83-00001 needs your approval');
    expect(text(html)).toContain('To asha@example.test');
    expect(text(html)).toContain('Failed');
    expect(text(html)).toContain('550 mailbox unavailable');
    expect(html).toContain('>Resend</button>');
    // No template key or row id on the screen.
    expect(text(html)).not.toContain('approval.pending');
    expect(text(html)).not.toContain(ID);
  });

  it('shows the log without Resend to a person who may only read it', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read'));
    const html = await render();

    expect(text(html)).toContain('MEMO-2082/83-00001 needs your approval');
    expect(html).not.toContain('>Resend</button>');
  });

  it('offers no Resend on a delivered email', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read', 'email_delivery.resend'));
    api.listEmailDeliveries.mockResolvedValue({
      items: [
        item({
          state: 'delivered',
          canResend: false,
          lastError: null,
          sentAt: '2026-11-20T04:01:00.000Z',
        }),
      ],
      nextBefore: null,
    });
    const html = await render({ show: 'all' });

    expect(api.listEmailDeliveries).toHaveBeenCalledWith(expect.anything(), {
      filter: 'all',
      before: undefined,
    });
    expect(text(html)).toContain('Delivered');
    expect(html).not.toContain('>Resend</button>');
  });

  it('links to the older page and ignores a cursor that is not an id', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read'));
    api.listEmailDeliveries.mockResolvedValue({ items: [item()], nextBefore: ID });
    const html = await render({ before: 'drop table' });

    expect(api.listEmailDeliveries).toHaveBeenCalledWith(expect.anything(), {
      filter: 'failed',
      before: undefined,
    });
    expect(html).toContain(`href="/settings/email-delivery?before=${ID}"`);
  });

  it('says so when nothing failed', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read'));
    api.listEmailDeliveries.mockResolvedValue({ items: [], nextBefore: null });
    expect(text(await render())).toContain('No failed emails');
  });

  it('sends a person without the live grant away, even with a role that once had it', async () => {
    getSession.mockResolvedValue({
      accessToken: 't',
      orgKind: 'staff',
      roles: ['founder'],
    } as Session);
    getMe.mockResolvedValue(grants('quotation.read'));
    await expect(render()).rejects.toThrow(/REDIRECT:/);
    expect(api.listEmailDeliveries).not.toHaveBeenCalled();
  });
});

describe('resendEmailAction', () => {
  it('resends, refreshes the page and says the email is queued', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read', 'email_delivery.resend'));
    api.resendEmail.mockResolvedValue({ outcome: 'queued' });

    const result = await resendEmailAction(ID);

    expect(api.resendEmail).toHaveBeenCalledWith(expect.anything(), ID);
    expect(result).toEqual({
      status: 'ok',
      message: 'The email is queued and will be sent again in a moment.',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/email-delivery');
  });

  it('says when the email was already waiting (a double click)', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read', 'email_delivery.resend'));
    api.resendEmail.mockResolvedValue({ outcome: 'already_queued' });
    expect(await resendEmailAction(ID)).toMatchObject({
      status: 'ok',
      message: 'This email is already waiting to be sent.',
    });
  });

  it("shows the API's reason when the email was already delivered (409)", async () => {
    getMe.mockResolvedValue(grants('email_delivery.read', 'email_delivery.resend'));
    api.resendEmail.mockRejectedValue(
      new ApiError(409, 'conflict', {
        error: {
          code: 'conflict',
          message: 'This email was delivered, so it cannot be sent again.',
          correlationId: 'corr-12345678',
        },
      }),
    );
    expect(await resendEmailAction(ID)).toEqual({
      status: 'error',
      message: 'This email was delivered, so it cannot be sent again.',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/email-delivery');
  });

  it('refuses a bad id without calling the API', async () => {
    getMe.mockResolvedValue(grants('email_delivery.read', 'email_delivery.resend'));
    expect(await resendEmailAction('../../v1/admin/users')).toMatchObject({ status: 'error' });
    expect(api.resendEmail).not.toHaveBeenCalled();
  });

  it('refuses a person who may not open the section', async () => {
    getMe.mockResolvedValue(grants('quotation.read'));
    await expect(resendEmailAction(ID)).rejects.toThrow(/REDIRECT:/);
    expect(api.resendEmail).not.toHaveBeenCalled();
  });
});

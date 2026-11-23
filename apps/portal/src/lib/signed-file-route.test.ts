import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';
import { SessionUnavailableError } from '@/lib/session-unavailable';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const { handleSignedFile } = await import('./signed-file-route');

const session = { orgKind: 'customer', accessToken: 't' } as unknown as Session;
const LINK = { url: '/v1/files/tok', expiresAt: '2026-11-09T10:00:00Z' };
const getLink = vi.fn<(s: Session, id: string) => Promise<typeof LINK>>();
const openFile = vi.fn<(s: Session, l: typeof LINK) => Promise<Response>>();

const run = (mode: 'download' | 'preview', orgKind: Session['orgKind'] = 'customer') =>
  handleSignedFile({
    mode,
    orgKind,
    notFound: 'Nope.',
    signIn: 'Sign in.',
    isId: (id) => id === 'good',
    params: Promise.resolve({ id: 'good' }),
    getLink,
    openFile,
  });

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(session);
  getLink.mockReset().mockResolvedValue(LINK);
  openFile.mockReset();
});

describe('handleSignedFile', () => {
  it('checks the session, then the org kind, then the id, before any API call', async () => {
    getSession.mockRejectedValueOnce(new SessionUnavailableError());
    expect((await run('download')).status).toBe(503);
    getSession.mockResolvedValueOnce(null);
    expect((await run('download')).status).toBe(401);
    expect((await run('download', 'vendor')).status).toBe(404);
    const bad = await handleSignedFile({
      mode: 'download',
      orgKind: 'customer',
      notFound: 'Nope.',
      signIn: 'Sign in.',
      isId: () => false,
      params: Promise.resolve({ id: 'x' }),
      getLink,
      openFile,
    });
    expect(bad.status).toBe(404);
    expect(getLink).not.toHaveBeenCalled();
  });

  it('download keeps the API headers, including its sandbox CSP and attachment', async () => {
    openFile.mockResolvedValue(
      new Response('x', {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="a.pdf"',
          'content-security-policy': 'sandbox',
        },
      }),
    );
    const res = await run('download');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a.pdf"');
  });

  it('preview rewrites attachment to inline, drops the CSP and issues exactly one link', async () => {
    openFile.mockResolvedValue(
      new Response('x', {
        headers: {
          'content-type': 'Application/PDF; charset=binary',
          'content-disposition': 'attachment; filename="a.pdf"',
          'content-security-policy': 'sandbox',
          'content-length': '1',
        },
      }),
    );
    const res = await run('preview');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('inline; filename="a.pdf"');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-length')).toBe('1');
    expect(getLink).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it('preview answers 415 for a non-PDF and a bare inline when no filename is given', async () => {
    openFile.mockResolvedValueOnce(new Response('x', { headers: { 'content-type': 'image/png' } }));
    expect((await run('preview')).status).toBe(415);
    openFile.mockResolvedValueOnce(
      new Response('x', { headers: { 'content-type': 'application/pdf' } }),
    );
    expect((await run('preview')).headers.get('content-disposition')).toBe('inline');
  });

  it('maps API failures the same way in both modes', async () => {
    for (const mode of ['download', 'preview'] as const) {
      for (const [status, expected] of [
        [404, 404],
        [403, 404],
        [401, 401],
        [409, 409],
        [410, 409],
        [500, 502],
      ] as const) {
        getLink.mockRejectedValueOnce(new ApiError(status, 'x'));
        expect((await run(mode)).status).toBe(expected);
      }
    }
  });

  it('answers 410 when the signed link ran out or the file is gone, 404 when it is missing, 503 when busy (R6D)', async () => {
    for (const mode of ['download', 'preview'] as const) {
      for (const [status, expected] of [
        [401, 410],
        [410, 410],
        [404, 404],
        [503, 503],
      ] as const) {
        openFile.mockRejectedValueOnce(new ApiError(status, 'x'));
        const res = await run(mode);
        expect(res.status, `${mode} ${status}`).toBe(expected);
        if (expected === 410) expect(await res.text()).toContain('expired');
      }
    }
    // A 401 from the link request itself still means "sign in".
    getLink.mockRejectedValueOnce(new ApiError(401, 'x'));
    expect((await run('download')).status).toBe(401);
  });

  it('answers a customer 424 (failed or refused PDF) as 424 with the delayed sentence, in both modes', async () => {
    for (const mode of ['download', 'preview'] as const) {
      getLink.mockRejectedValueOnce(new ApiError(424, 'x', { code: 'document_render_failed' }));
      const fromLink = await run(mode);
      expect(fromLink.status).toBe(424);
      expect(fromLink.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await fromLink.text()).toBe('This PDF is delayed. Our team has been told.');

      openFile.mockRejectedValueOnce(new ApiError(424, 'x'));
      const fromFile = await run(mode);
      expect(fromFile.status).toBe(424);
      expect(await fromFile.text()).toBe('This PDF is delayed. Our team has been told.');
    }
  });

  it('keeps 409 as "not ready yet" and 404 as not found, with no code in the text', async () => {
    getLink.mockRejectedValueOnce(new ApiError(409, 'x', { code: 'document_pending' }));
    const pending = await run('download');
    expect(pending.status).toBe(409);
    expect(await pending.text()).toBe(
      'This PDF is not available to download yet. Please try again in a few minutes.',
    );
    getLink.mockRejectedValueOnce(new ApiError(404, 'x'));
    const missing = await run('preview');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Nope.');
  });

  it('leaves the vendor purchase-order routes as they were: a 424 is still a 502, 409 still 409', async () => {
    const vendor = { orgKind: 'vendor', accessToken: 't' } as unknown as Session;
    for (const mode of ['download', 'preview'] as const) {
      for (const [status, expected] of [
        [424, 502],
        [409, 409],
        [404, 404],
      ] as const) {
        getSession.mockResolvedValueOnce(vendor);
        getLink.mockRejectedValueOnce(new ApiError(status, 'x'));
        const res = await run(mode, 'vendor');
        expect(res.status).toBe(expected);
        expect(await res.text()).not.toContain('delayed');
      }
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleVendorUpload = vi.hoisted(() => vi.fn());
vi.mock('../../../../_upload/route-handler', () => ({ handleVendorUpload }));

const route = await import('./route');

beforeEach(() => handleVendorUpload.mockReset());

describe('quotation file route', () => {
  it('hands the request to the shared upload handler as a quotation file, and answers with its response', async () => {
    const answer = new Response('{}', { status: 201 });
    handleVendorUpload.mockResolvedValue(answer);
    const req = new Request('https://app.test/vendor/rfqs/x/quote/file', { method: 'POST' });
    expect(await route.POST(req)).toBe(answer);
    expect(handleVendorUpload).toHaveBeenCalledExactlyOnceWith(req, 'quotation-submissions');
  });

  it('runs on Node and is never cached', () => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

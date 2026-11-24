// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('./toast', () => ({ toast: toasts }));

// The real shrinkImage refuses wrong types before touching a canvas; tests that need a decoded picture swap it out.
const resize = vi.hoisted(() => ({ shrink: null as null | ((file: File) => Promise<File>) }));
vi.mock('./image-resize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./image-resize')>();
  return {
    ...actual,
    shrinkImage: vi.fn((file: File) =>
      resize.shrink ? resize.shrink(file) : actual.shrinkImage(file),
    ),
  };
});

import { ImageUpload, scanPollDelays, type ImageUploadProps } from './image-upload';
import { ImageRefusal } from './image-resize';

const OWNER = '11111111-2222-4333-8444-555555555555';
const CURRENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UPLOADED = 'ffffffff-0000-4111-8222-333333333333';
const UPLOAD_URL = `/api/images/user_avatar/${OWNER}`;
const SCAN_URL = `/api/images/${UPLOADED}`;

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;
let scanStatuses: number[];
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
let onChange: Mock<(documentId: string | null) => void>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  resize.shrink = null;
  scanStatuses = [];
  onChange = vi.fn();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(json(200, { documentId: UPLOADED }));
    if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    if (url === SCAN_URL)
      return Promise.resolve(new Response(null, { status: scanStatuses.shift() ?? 404 }));
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function picker(props: Partial<ImageUploadProps> = {}) {
  return (
    <ImageUpload
      ownerType="user_avatar"
      ownerId={OWNER}
      imageDocumentId={CURRENT}
      name="Ada Lovelace"
      seedId={OWNER}
      shape="circle"
      fit="cover"
      label="Profile picture"
      onChange={onChange}
      {...props}
    />
  );
}

/** Lets awaited promises (shrink, fetch, json) run, with or without fake timers. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('No file input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return Promise.resolve();
  });
  await settle();
}

function byName(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('button')].find(
    (element) =>
      element.getAttribute('aria-label') === name || element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button "${name}"`);
  return found;
}

function png(name = 'photo.png', bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

function calls(method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);
}

describe('scanPollDelays', () => {
  it('doubles from one second, caps at fifteen and fits one minute', () => {
    const delays = scanPollDelays();
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(60_000);
  });

  it('never exceeds the budget and stops on a cap reached early', () => {
    expect(scanPollDelays(10_000)).toEqual([1_000, 2_000, 4_000]);
    expect(scanPollDelays(9_000, 1_000, 3_000)).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it('gives no checks for a zero or invalid schedule instead of looping', () => {
    expect(scanPollDelays(0)).toEqual([]);
    expect(scanPollDelays(60_000, 0)).toEqual([]);
    expect(scanPollDelays(60_000, 1_000, 0)).toEqual([]);
    expect(scanPollDelays(500)).toEqual([]);
  });
});

describe('ImageUpload', () => {
  it('names every control after the subject', async () => {
    mounted = await mountForm(picker());
    expect(document.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Profile picture',
    );
    expect(byName('View Ada Lovelace picture').tagName).toBe('BUTTON');
    expect(byName('Remove Ada Lovelace picture').tagName).toBe('BUTTON');

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('image/png,image/jpeg,image/webp');
    const title = document.getElementById(input.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('Replace picture');
    expect(
      document.getElementById(input.getAttribute('aria-describedby')!)?.textContent,
    ).not.toMatch(/512\s?KB|PNG, JPEG or WebP/);
  });

  // U12-Q4: the customer profile card asks for the larger picture; every other caller keeps 40 px.
  it('shows the picture at the size asked for, 40 px (large) by default, initials included', async () => {
    const avatarClass = () =>
      document.querySelector<HTMLElement>('[role="group"] span[aria-hidden="true"]')?.className ??
      '';
    mounted = await mountForm(picker({ imageDocumentId: null }));
    expect(avatarClass()).toMatch(/(^|[\s_])large_/);
    expect(avatarClass()).not.toMatch(/xlarge/);
    await mounted.unmount();
    mounted = undefined;
    mounted = await mountForm(picker({ imageDocumentId: null, size: 'xlarge' }));
    expect(avatarClass()).toMatch(/xlarge/);
    expect(document.querySelector('[role="group"] span[aria-hidden="true"]')?.textContent).toBe(
      'AL',
    );
  });

  it('offers an upload, and no preview or remove, while there is no picture', async () => {
    mounted = await mountForm(picker({ imageDocumentId: null }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(document.getElementById(input.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Upload picture',
    );
    expect(() => byName('View Ada Lovelace picture')).toThrow();
    expect(() => byName('Remove Ada Lovelace picture')).toThrow();
  });

  it('read only shows the picture and its preview, nothing to change', async () => {
    mounted = await mountForm(picker({ readOnly: true }));
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(() => byName('Remove Ada Lovelace picture')).toThrow();
    await click(byName('View Ada Lovelace picture'));
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      `/api/images/${CURRENT}`,
    );
    expect(() => byName('Replace')).toThrow();
    expect(byName('Close')).toBeTruthy();
  });

  it('opens the preview with Replace and Close in the footer', async () => {
    mounted = await mountForm(picker());
    await click(byName('View Ada Lovelace picture'));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Profile picture');
    expect(dialog?.querySelector('img')?.getAttribute('alt')).toBe('Ada Lovelace picture');
    expect(byName('Replace')).toBeTruthy();
    expect(byName('Close')).toBeTruthy();
  });

  it('refuses a file that is not a picture with a toast and no request', async () => {
    mounted = await mountForm(picker());
    await choose(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(String(toasts.error.mock.calls[0]?.[0])).toContain('PNG, JPEG or WebP');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a picture still too large after shrinking with a toast and no request', async () => {
    resize.shrink = () =>
      Promise.reject(new ImageRefusal('This picture is too large even after shrinking'));
    mounted = await mountForm(picker());
    await choose(png('huge.png'));
    expect(toasts.error).toHaveBeenCalledWith('This picture is too large even after shrinking');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uploads the shrunk picture at once and reports the new document', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker());
    await choose(png('original.png', 4_096));

    const posts = calls('POST');
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0]!;
    expect(url).toBe(UPLOAD_URL);
    expect(init?.headers).toBeUndefined();
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    const sent = (body as FormData).get('file') as File;
    expect(sent.name).toBe('shrunk.png');
    expect(sent.size).toBe(32);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(UPLOADED);
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Scanning');
  });

  it('uploads a dropped file the same way', async () => {
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker({ imageDocumentId: null }));
    const zone = document.querySelector('label')!;
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [png()] } });
    await act(() => {
      zone.dispatchEvent(drop);
      return Promise.resolve();
    });
    await settle();
    expect(calls('POST')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledWith(UPLOADED);
  });

  it('shows the server refusal in a toast and keeps the picture', async () => {
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(json(403, { error: { message: 'You cannot change this picture.' } })),
    );
    mounted = await mountForm(picker());
    await choose(png());
    expect(toasts.error).toHaveBeenCalledWith('You cannot change this picture.');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).not.toContain('Scanning');
  });

  it('keeps the server refusal in the field message line after the toast, and clears it on the next pick (R6Q4)', async () => {
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        json(413, { error: { message: 'The picture is too large. Use one up to 512 KB.' } }),
      ),
    );
    mounted = await mountForm(picker());
    await choose(png());
    const line = () => document.querySelector('p[role="status"]');
    expect(document.body.textContent).toContain('The picture is too large. Use one up to 512 KB.');
    expect(line()?.textContent).toBe('The picture is too large. Use one up to 512 KB.');
    await choose(png());
    expect(document.body.textContent).not.toContain('Use one up to 512 KB.');
  });

  it('polls the scan on the backoff schedule and, after a minute, stops and says so once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker());
    await choose(png());
    const scans = () => fetchMock.mock.calls.filter(([url]) => url === SCAN_URL).length;
    expect(scans()).toBe(0);

    let expected = 0;
    for (const delay of scanPollDelays()) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(scans()).toBe(expected);
      // Nothing is said while the budget lasts.
      expect(toasts.error).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expected += 1;
      expect(scans()).toBe(expected);
    }
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).not.toContain('Scanning');
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith(
      'The picture could not be used yet. If it does not appear soon, upload another.',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(scans()).toBe(7);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the picture is served on the last check of the budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scanStatuses = [404, 404, 404, 404, 404, 404, 200];
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker());
    await choose(png());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === SCAN_URL)).toHaveLength(7);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('says nothing when unmounted part way through the scan', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker());
    await choose(png());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === SCAN_URL).length).toBeGreaterThan(0);
    await mounted.unmount();
    mounted = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('says nothing for a scan the user removed part way through', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker());
    await choose(png());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await click(byName('Remove Ada Lovelace picture'));
    await click(byName('Remove picture'));
    await settle();
    expect(calls('DELETE')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('says it once, at the end of the newer budget, when a second upload replaces a scan', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    const budget = scanPollDelays().reduce((sum, delay) => sum + delay, 0);
    mounted = await mountForm(picker());
    await choose(png());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await choose(png('second.png'));
    expect(calls('POST')).toHaveLength(2);
    // Past the first upload's budget end, before the second's.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(budget - 1);
    });
    expect(toasts.error).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(toasts.error).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it('stops polling as soon as the picture is served', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scanStatuses = [404, 200];
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker());
    await choose(png());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const scans = () => fetchMock.mock.calls.filter(([url]) => url === SCAN_URL).length;
    expect(scans()).toBe(2);
    expect(document.querySelector('[role="status"]')?.textContent).not.toContain('Scanning');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(scans()).toBe(2);
  });

  it('reports the document again, and tells the page, once the picture is served', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scanStatuses = [404, 200];
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    const announced: unknown[] = [];
    const listen = (event: Event) => announced.push((event as CustomEvent<unknown>).detail);
    window.addEventListener('bos:image-ready', listen);
    try {
      mounted = await mountForm(picker());
      await choose(png());
      expect(onChange.mock.calls).toEqual([[UPLOADED]]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      // Still scanning: nothing more yet.
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(announced).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(onChange.mock.calls).toEqual([[UPLOADED], [UPLOADED]]);
      expect(announced).toEqual([SCAN_URL]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('bos:image-ready', listen);
    }
  });

  describe('a scan answer that arrives after the upload stopped being current', () => {
    /** Holds the next scan request open until `serve()` answers it with 200. */
    function holdScan() {
      const held: { serve: () => void } = { serve: () => undefined };
      const fallback = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === SCAN_URL && !init?.method) {
          return new Promise<Response>((resolve) => {
            held.serve = () => resolve(new Response(null, { status: 200 }));
          });
        }
        return fallback(url, init);
      });
      return held;
    }

    async function uploadAndHoldTheFirstCheck() {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
      const held = holdScan();
      mounted = await mountForm(picker());
      await choose(png());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(fetchMock.mock.calls.filter(([url]) => url === SCAN_URL)).toHaveLength(1);
      return held;
    }

    async function serveAndWait(held: { serve: () => void }) {
      await act(async () => {
        held.serve();
        await vi.advanceTimersByTimeAsync(0);
      });
      await settle();
    }

    it('does not report it after an unmount', async () => {
      const held = await uploadAndHoldTheFirstCheck();
      await mounted!.unmount();
      mounted = undefined;
      await serveAndWait(held);
      expect(onChange.mock.calls).toEqual([[UPLOADED]]);
    });

    it('does not report it after a removal', async () => {
      const held = await uploadAndHoldTheFirstCheck();
      await click(byName('Remove Ada Lovelace picture'));
      await click(byName('Remove picture'));
      await settle();
      expect(calls('DELETE')).toHaveLength(1);
      await serveAndWait(held);
      expect(onChange.mock.calls).toEqual([[UPLOADED], [null]]);
    });

    it('does not report it after a newer upload', async () => {
      const SECOND = '99999999-8888-4777-8666-555555555555';
      const held = await uploadAndHoldTheFirstCheck();
      const current = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Promise.resolve(json(200, { documentId: SECOND }))
          : current(url, init),
      );
      await choose(png('second.png'));
      expect(onChange.mock.calls).toEqual([[UPLOADED], [SECOND]]);
      await serveAndWait(held);
      // The second picture never passes its scan here, so its watch runs out without a second report either.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_000);
      });
      expect(onChange.mock.calls).toEqual([[UPLOADED], [SECOND]]);
    });
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resize.shrink = () => Promise.resolve(png('shrunk.png', 32));
    mounted = await mountForm(picker());
    await choose(png());
    await mounted.unmount();
    mounted = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === SCAN_URL)).toHaveLength(0);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('removes only after the confirmation, then reports null', async () => {
    mounted = await mountForm(picker());
    await click(byName('Remove Ada Lovelace picture'));
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog?.textContent).toContain('Remove the picture of Ada Lovelace?');
    expect(fetchMock).not.toHaveBeenCalled();

    await click(byName('Remove picture'));
    await settle();
    const deletes = calls('DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.[0]).toBe(UPLOAD_URL);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(toasts.success).toHaveBeenCalledWith('Picture removed');
  });

  it('keeps the confirmation open and toasts when the removal is refused', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('oops', { status: 500 })));
    mounted = await mountForm(picker());
    await click(byName('Remove Ada Lovelace picture'));
    await click(byName('Remove picture'));
    await settle();
    expect(toasts.error).toHaveBeenCalledWith('The picture could not be removed. Try again.');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).not.toBeNull();
  });

  it('cancelling the confirmation sends nothing', async () => {
    mounted = await mountForm(picker());
    await click(byName('Remove Ada Lovelace picture'));
    await click(byName('Cancel'));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
// R6Q5: whatever picture is chosen is shrunk in the browser until it is at most 512 KB, and only then sent. The real
// shrinkImage runs here; only the canvas is replaced by one whose encoded size depends on the pixels drawn.
import { IMAGE_MAX_BYTES } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

vi.mock('./toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ImageUpload } from './image-upload';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const OWNER = '11111111-2222-4333-8444-555555555555';

let posted: File[];
let encodedTypes: string[];
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

/** A canvas whose PNG/JPEG size is `bytesPerPixel` times the pixels drawn (JPEG also scales with its quality). */
function stubCanvas(source: { width: number; height: number }, bytesPerPixel: number) {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ ...source, close: vi.fn() })),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      private drawn = 0;
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { fillStyle: '', fillRect: () => undefined, drawImage: () => (this.drawn += 1) };
      }
      convertToBlob(options: { type?: string; quality?: number }) {
        encodedTypes.push(options.type ?? '');
        const size = Math.round(this.width * this.height * bytesPerPixel * (options.quality ?? 1));
        return Promise.resolve(new Blob([new Uint8Array(size)], { type: options.type ?? '' }));
      }
    },
  );
}

beforeEach(() => {
  posted = [];
  encodedTypes = [];
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push((init.body as FormData).get('file') as File);
        return Promise.resolve(
          new Response(JSON.stringify({ documentId: 'ffffffff-0000-4111-8222-333333333333' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
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
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('No file input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  });
}

const slot = (
  <ImageUpload
    ownerType="user_avatar"
    ownerId={OWNER}
    imageDocumentId={null}
    name="Ada Lovelace"
    seedId={OWNER}
    shape="square"
    fit="contain"
    label="Company logo"
    onChange={() => undefined}
  />
);

describe('every logo slot fits whatever picture is chosen (R6Q5)', () => {
  it('a 600 KB PNG with transparency is sent as a PNG of at most 512 KB', async () => {
    // 1200x1200 at 0.42 bytes/px is ~600 KB at full size; 512 px or smaller brings it under.
    stubCanvas({ width: 1200, height: 1200 }, 0.42);
    mounted = await mountForm(slot);
    await choose(new File([new Uint8Array([...PNG_HEAD, 1])], 'logo.png', { type: 'image/png' }));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('image/png');
    expect(posted[0]!.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(encodedTypes.every((type) => type === 'image/png')).toBe(true);
  });

  it('a 4 MB JPEG is sent as a JPEG of at most 512 KB', async () => {
    // 4000x3000 photo, dense: even 512 px wide needs the quality and size steps to fit.
    stubCanvas({ width: 4000, height: 3000 }, 4);
    mounted = await mountForm(slot);
    await choose(
      new File([new Uint8Array([...JPEG_HEAD, 1])], 'photo.jpg', { type: 'image/jpeg' }),
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('image/jpeg');
    expect(posted[0]!.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(posted[0]!.size).toBeGreaterThan(0);
  });

  it('shows no size or type hint, at any slot size', async () => {
    mounted = await mountForm(slot);
    expect(document.body.textContent).not.toMatch(/512\s?KB/);
    expect(document.body.textContent).not.toMatch(/PNG, JPEG or WebP/);
    expect(document.body.textContent).toContain('Upload picture');
    await mounted.unmount();
    mounted = await mountForm(
      <ImageUpload
        ownerType="user_avatar"
        ownerId={OWNER}
        imageDocumentId={null}
        name="Ada"
        seedId={OWNER}
        shape="square"
        fit="contain"
        label="Company logo"
        size="xlarge"
        onChange={() => undefined}
      />,
    );
    expect(document.body.textContent).not.toMatch(/512\s?KB|PNG, JPEG or WebP/);
  });
});

// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE } from '../action-state';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/documents',
  useRouter: () => ({ replace: vi.fn() }),
}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (path: string): void => {
    revalidatePath(path);
  },
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getSetting = vi.fn();
const putSetting = vi.fn();
vi.mock('@/lib/api-admin', () => ({
  getSetting: (session: unknown, key: string): unknown => getSetting(session, key),
  putSetting: (session: unknown, key: string, value: unknown): unknown =>
    putSetting(session, key, value),
}));
const apiFetch = vi.fn<(session: unknown, path: string, init?: RequestInit) => Promise<Response>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (session: unknown, path: string, init?: RequestInit) => apiFetch(session, path, init),
}));

const { default: DocumentsPage } = await import('./page');
const { saveDocumentStyleAction, previewsAction } = await import('./actions');
const { loadPreviews } = await import('./previews');
const { ApiError } = await import('@/lib/api');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

const bodyOf = (init?: RequestInit): string => (typeof init?.body === 'string' ? init.body : '');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sentLayouts = () =>
  apiFetch.mock.calls.map(([, , init]) => (JSON.parse(bodyOf(init)) as { layout: string }).layout);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReset().mockResolvedValue(session(['founder']));
  getSetting.mockReset().mockResolvedValue({
    key: 'document.style',
    value: { layout: 'ledger', primaryColour: '#0f766e' },
    version: 2,
  });
  putSetting.mockReset().mockResolvedValue({ version: 3 });
  apiFetch.mockReset().mockImplementation((_s, _p, init) => {
    const { layout } = JSON.parse(bodyOf(init)) as { layout: string };
    return Promise.resolve(json({ html: `<p>sample ${layout}</p>` }));
  });
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe('the Document templates page', () => {
  it('sends a sales user to the no-access page and reads nothing', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(DocumentsPage()).rejects.toThrow('REDIRECT:/settings/denied');
    expect(getSetting).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows the caption, five layouts, the saved selection, seven preset colours and a Custom dot', async () => {
    const html = renderToStaticMarkup((await DocumentsPage()) as ReactElement);
    expect(html).toContain(
      'Changes apply to new documents and drafts. Documents already sent keep the look they were sent with.',
    );
    expect(html).toContain('Used on documents your customers and vendors receive.');
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html).toMatch(/checked=""[^>]*value="ledger"/);
    expect(html).toContain('name="primaryColour" value="#0f766e"');
    for (const name of ['Ocean', 'Teal', 'Forest', 'Amber', 'Crimson', 'Violet', 'Slate']) {
      expect(html).toContain(`aria-label="${name}, `);
    }
    expect(html).toContain('aria-label="Custom colour"');
    expect(html.match(/<iframe/g)).toHaveLength(5);
    expect(html).toContain('sandbox=""');
    expect(sentLayouts().sort()).toEqual([
      'banded',
      'duo-cards',
      'ledger',
      'side-labels',
      'tinted',
    ]);
  });

  it('offers the undo icon for a style that differs from the default, naming the default', async () => {
    const html = renderToStaticMarkup((await DocumentsPage()) as ReactElement);
    expect(html).toContain('aria-label="Reset Document style to default"');
    // The default shows in the design-system Tooltip (opens on hover or focus), never as a native title bubble.
    expect(html).not.toMatch(/<button[^>]* title=/);
  });

  it('shows no undo icon while the saved style is the default', async () => {
    getSetting.mockResolvedValue({
      key: 'document.style',
      value: { layout: 'banded', primaryColour: '#1D4ED8' },
      version: 1,
    });
    const html = renderToStaticMarkup((await DocumentsPage()) as ReactElement);
    expect(html).not.toContain('Reset Document style to default');
  });

  it('falls back to the default style when the stored value cannot be read', async () => {
    getSetting.mockResolvedValue({ key: 'document.style', value: { layout: 'glow' }, version: 1 });
    const html = renderToStaticMarkup((await DocumentsPage()) as ReactElement);
    expect(html).toMatch(/checked=""[^>]*value="banded"/);
    expect(html).toContain('name="primaryColour" value="#1d4ed8"');
  });

  it('shows a placeholder for a layout whose preview fails and still renders the rest', async () => {
    apiFetch.mockImplementation((_s, _p, init) => {
      const { layout } = JSON.parse(bodyOf(init)) as { layout: string };
      return layout === 'tinted'
        ? Promise.reject(new Error('renderer down'))
        : Promise.resolve(json({ html: `<p>${layout}</p>` }));
    });
    const html = renderToStaticMarkup((await DocumentsPage()) as ReactElement);
    expect(html.match(/<iframe/g)).toHaveLength(4);
    expect(html).toContain('Preview unavailable');
    expect(html).toContain('Tinted header');
  });

  it('says in words that the style cannot be read, and shows no form', async () => {
    getSetting.mockRejectedValue(new ApiError(403, 'no'));
    const html = renderToStaticMarkup((await DocumentsPage()) as ReactElement);
    expect(html).toContain('You don&#x27;t have permission to view the document style.');
    expect(html).not.toContain('type="radio"');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('loadPreviews', () => {
  it('turns every kind of failure into a null for that layout only', async () => {
    apiFetch.mockImplementation((_s, _p, init) => {
      const { layout } = JSON.parse(bodyOf(init)) as { layout: string };
      if (layout === 'banded') return Promise.resolve(json({ nope: 1 }));
      if (layout === 'ledger') return Promise.resolve(json({ message: 'x' }, 500));
      if (layout === 'tinted') return Promise.reject(new Error('down'));
      return Promise.resolve(json({ html: `<p>${layout}</p>` }));
    });
    const previews = await loadPreviews(session(['founder']), '#1d4ed8');
    expect(previews).toEqual({
      banded: null,
      ledger: null,
      tinted: null,
      'duo-cards': '<p>duo-cards</p>',
      'side-labels': '<p>side-labels</p>',
    });
    const [, path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe('/v1/admin/settings/documents/preview');
    expect(init?.method).toBe('POST');
  });
});

describe('saveDocumentStyleAction', () => {
  it('checks the documents section first, then writes document.style and nothing else', async () => {
    const result = await saveDocumentStyleAction(
      IDLE,
      form({
        layout: 'tinted',
        primaryColour: '#B45309',
        key: 'tax.vat_rate',
        value: '99',
        extra: 'x',
      }),
    );
    expect(result).toEqual({ status: 'ok', message: 'Document style saved.' });
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 't' }),
      'document.style',
      { layout: 'tinted', primaryColour: '#b45309' },
    );
    expect(revalidatePath).toHaveBeenCalledWith('/settings/documents');
  });

  it('refuses a bad colour or layout with a message and writes nothing', async () => {
    for (const bad of [
      { layout: 'tinted', primaryColour: 'blue' },
      { layout: 'tinted', primaryColour: '#12345' },
      { layout: 'tinted', primaryColour: '' },
      { layout: 'tinted' },
    ]) {
      const result = await saveDocumentStyleAction(IDLE, form(bad));
      expect(result.status).toBe('error');
      expect(result.message).toContain('six hex digits');
    }
    const wrongLayout = await saveDocumentStyleAction(
      IDLE,
      form({ layout: 'glow', primaryColour: '#1d4ed8' }),
    );
    expect(wrongLayout).toEqual({ status: 'error', message: 'Choose one of the layouts.' });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('is refused before anything is parsed or written for a person without the section', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(
      saveDocumentStyleAction(IDLE, form({ layout: 'tinted', primaryColour: '#1d4ed8' })),
    ).rejects.toThrow('REDIRECT:/settings/denied');
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('reports an API failure instead of claiming success', async () => {
    putSetting.mockRejectedValue(new ApiError(403, 'no'));
    const result = await saveDocumentStyleAction(
      IDLE,
      form({ layout: 'tinted', primaryColour: '#1d4ed8' }),
    );
    expect(result.status).toBe('error');
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('previewsAction', () => {
  it('is refused for a person without the section, before any request', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(previewsAction('#1d4ed8')).rejects.toThrow('REDIRECT:/settings/denied');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('ignores a colour that is not a six-digit hex, without calling the API', async () => {
    expect(await previewsAction('red')).toBeNull();
    expect(await previewsAction('#abc')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('sends the lower-cased colour for all five layouts', async () => {
    const previews = await previewsAction('#0F766E');
    expect(previews?.banded).toBe('<p>sample banded</p>');
    expect(apiFetch).toHaveBeenCalledTimes(5);
    for (const [, , init] of apiFetch.mock.calls) {
      expect(JSON.parse(bodyOf(init))).toMatchObject({ primaryColour: '#0f766e' });
    }
  });
});

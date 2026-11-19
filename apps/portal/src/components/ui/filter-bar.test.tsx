// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilterBar, ResultCount, useFilterNavigation } from './filter-bar';

// Real React handlers without a browser (portal has no shared helper).
async function fill(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  await act(() => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return Promise.resolve();
  });
}

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/leads',
  useSearchParams: () => params,
}));

let root: Root;
let container: HTMLDivElement;

function Harness() {
  const { setParam } = useFilterNavigation();
  return (
    <>
      <button type="button" onClick={() => setParam('status', ['new', 'won'])}>
        pick statuses
      </button>
      <button type="button" onClick={() => setParam('owner', 'ana')}>
        pick owner
      </button>
      <button type="button" onClick={() => setParam('status', [])}>
        clear statuses
      </button>
    </>
  );
}

const bar = (children?: ReactNode) => (
  <FilterBar
    search={{ label: 'Search leads', placeholder: 'Search name or company' }}
    preserve={{ view: 'board', rows: undefined }}
  >
    {children}
  </FilterBar>
);

async function mount(url = '', children?: ReactNode) {
  params = new URLSearchParams(url);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => Promise.resolve(root.render(bar(children))));
}

/** The server re-rendered at a new URL: our own echo, or the user pressing Back. */
async function goTo(url: string, children?: ReactNode) {
  params = new URLSearchParams(url);
  await act(() => Promise.resolve(root.render(bar(children))));
}

function advance(ms: number) {
  return act(() => {
    vi.advanceTimersByTime(ms);
    return Promise.resolve();
  });
}

const input = () => container.querySelector<HTMLInputElement>('input[type="search"]')!;
const button = (name: string) =>
  Array.from(container.querySelectorAll('button')).find((el) => el.textContent === name)!;
const click = (el: HTMLElement) => act(() => Promise.resolve(el.click()));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  router.push.mockClear();
  router.replace.mockClear();
});

afterEach(async () => {
  await act(() => Promise.resolve(root.unmount()));
  container.remove();
  vi.useRealTimers();
});

const NO_SCROLL = { scroll: false };

describe('FilterBar form', () => {
  it('is a real GET search form with hidden preserved params and no submit button', async () => {
    await mount();
    const form = container.querySelector('form')!;
    expect(form.method).toBe('get');
    expect(form.getAttribute('role')).toBe('search');
    expect(form.getAttribute('action')).toBe('/leads');
    expect(input().name).toBe('q');
    expect(input().getAttribute('aria-label')).toBe('Search leads');
    expect(container.querySelector('input[type="hidden"][name="view"]')).not.toBeNull();
    expect(container.querySelector('input[name="rows"]')).toBeNull();
    expect(container.querySelector('button[type="submit"], input[type="submit"]')).toBeNull();
  });

  it('submits on Enter immediately, without waiting for the debounce', async () => {
    await mount();
    await fill(input(), 'acme');
    const event = new Event('submit', { bubbles: true, cancelable: true });
    await act(() => Promise.resolve(container.querySelector('form')!.dispatchEvent(event)));
    expect(event.defaultPrevented).toBe(true);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/leads?q=acme', NO_SCROLL);
    await advance(500);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });
});

describe('search', () => {
  it('debounces typing by 250ms and replaces the URL once', async () => {
    await mount();
    await fill(input(), 'ac');
    await advance(200);
    await fill(input(), 'acme');
    await advance(200);
    expect(router.replace).not.toHaveBeenCalled();
    await advance(60);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/leads?q=acme', NO_SCROLL);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('removes q when fewer than 2 characters are left, and trims', async () => {
    await mount('q=acme');
    await fill(input(), 'a');
    await advance(250);
    expect(router.replace).toHaveBeenLastCalledWith('/leads', NO_SCROLL);
    expect(input().value).toBe('a');
    await goTo('');
    await fill(input(), '  ab  ');
    await advance(250);
    expect(router.replace).toHaveBeenLastCalledWith('/leads?q=ab', NO_SCROLL);
  });

  it('does not navigate when the normalized search equals the URL', async () => {
    await mount('q=acme');
    await fill(input(), 'acme ');
    await advance(250);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('drops page and keeps every other param', async () => {
    await mount('view=board&rows=50&page=3&status=new&status=won');
    await fill(input(), 'acm');
    await advance(250);
    expect(router.replace).toHaveBeenCalledWith(
      '/leads?view=board&rows=50&status=new&status=won&q=acm',
      NO_SCROLL,
    );
  });

  it('clears on Escape immediately and leaves Escape alone when already empty', async () => {
    await mount('q=acme');
    expect(input().value).toBe('acme');
    const press = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      return act(() => {
        input().dispatchEvent(event);
        return Promise.resolve(event);
      });
    };
    const first = await press();
    expect(first.defaultPrevented).toBe(true);
    expect(input().value).toBe('');
    expect(router.replace).toHaveBeenCalledWith('/leads', NO_SCROLL);
    await goTo('');
    const second = await press();
    expect(second.defaultPrevented).toBe(false);
  });

  it('keeps what the user typed when our own search echoes back late', async () => {
    await mount('q=ab');
    await fill(input(), 'abc');
    await advance(250);
    expect(router.replace).toHaveBeenLastCalledWith('/leads?q=abc', NO_SCROLL);
    await fill(input(), 'abcd');
    await goTo('q=abc');
    expect(input().value).toBe('abcd');
    await advance(250);
    expect(router.replace).toHaveBeenLastCalledWith('/leads?q=abcd', NO_SCROLL);
    await goTo('q=abcd');
    expect(input().value).toBe('abcd');
  });

  it('is not reseeded when only another param changes while typing', async () => {
    await mount('q=ab');
    await fill(input(), 'abcdef');
    await goTo('q=ab&status=new');
    expect(input().value).toBe('abcdef');
    await advance(250);
    expect(router.replace).toHaveBeenLastCalledWith('/leads?q=abcdef&status=new', NO_SCROLL);
  });

  it('resyncs from the URL on back/forward and cancels a pending debounce', async () => {
    await mount('q=old');
    await fill(input(), 'newer');
    await goTo('q=other');
    expect(input().value).toBe('other');
    await advance(500);
    expect(router.replace).not.toHaveBeenCalled();
    await goTo('');
    expect(input().value).toBe('');
  });
});

describe('filter navigation', () => {
  it('pushes repeated params, drops page and keeps the search', async () => {
    await mount('q=acme&page=4&rows=50', <Harness />);
    await click(button('pick statuses'));
    expect(router.push).toHaveBeenCalledWith(
      '/leads?q=acme&rows=50&status=new&status=won',
      NO_SCROLL,
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('removes the param for an empty selection', async () => {
    await mount('status=new&status=won&view=board', <Harness />);
    await click(button('clear statuses'));
    expect(router.push).toHaveBeenCalledWith('/leads?view=board', NO_SCROLL);
  });

  it('builds quick successive changes on each other before the server answers', async () => {
    await mount('', <Harness />);
    await click(button('pick statuses'));
    await click(button('pick owner'));
    expect(router.push).toHaveBeenLastCalledWith(
      '/leads?status=new&status=won&owner=ana',
      NO_SCROLL,
    );
  });

  it('includes a filter change made while a search is still debouncing', async () => {
    await mount('', <Harness />);
    await fill(input(), 'acme');
    await click(button('pick owner'));
    await advance(250);
    expect(router.replace).toHaveBeenLastCalledWith('/leads?owner=ana&q=acme', NO_SCROLL);
  });

  it('throws a clear error outside a FilterBar', () => {
    const outside = document.createElement('div');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const other = createRoot(outside);
    expect(() => {
      void act(() => {
        other.render(<Harness />);
      });
    }).toThrow();
    spy.mockRestore();
  });
});

describe('ResultCount', () => {
  const text = async (node: ReactNode) => {
    await act(() => Promise.resolve(root.render(node)));
    const live = container.querySelector('[aria-live="polite"]');
    return live?.textContent;
  };

  beforeEach(() => {
    params = new URLSearchParams();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  it('is a polite live region with plain wording', async () => {
    expect(await text(<ResultCount shown={25} total={1234} noun="lead" />)).toBe(
      'Showing 25 of 1,234 leads',
    );
    expect(await text(<ResultCount shown={3} total={3} noun="lead" />)).toBe('3 leads');
    expect(await text(<ResultCount shown={1} total={1} noun="lead" />)).toBe('1 lead');
    expect(await text(<ResultCount shown={0} total={0} noun="company" plural="companies" />)).toBe(
      'No companies found',
    );
    expect(container.querySelector('p')?.getAttribute('aria-atomic')).toBe('true');
  });
});

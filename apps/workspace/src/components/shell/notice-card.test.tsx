// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { NoticeCard } from './notice-card';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2031-06-15T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it('renders one h1, the text, the actions and the current year in the main landmark', async () => {
  const view = await mountForm(
    <NoticeCard title="We could not sign you in" actions={<a href="/auth/login">Try again</a>}>
      <p>Something went wrong.</p>
    </NoticeCard>,
  );
  const main = document.querySelector('main');
  expect(main).not.toBeNull();
  expect(main?.querySelectorAll('h1')).toHaveLength(1);
  expect(main?.querySelector('h1')?.textContent).toBe('We could not sign you in');
  expect(main?.textContent).toContain('Something went wrong.');
  expect(main?.querySelector('a[href="/auth/login"]')?.textContent).toBe('Try again');
  expect(main?.querySelector('footer')?.textContent).toContain('© 2031 Business OS');
  await view.unmount();
});

it('omits the actions block when there are none', async () => {
  const view = await mountForm(
    <NoticeCard title="Nothing to do">
      <p>Text</p>
    </NoticeCard>,
  );
  expect(document.querySelector('a, button')).toBeNull();
  await view.unmount();
});

it('shows no footer links when none are configured', async () => {
  const view = await mountForm(
    <NoticeCard title="T" footerLinks={{ helpUrl: undefined, privacyUrl: undefined }}>
      <p>Text</p>
    </NoticeCard>,
  );
  expect(document.querySelector('footer nav')).toBeNull();
  expect(document.querySelector('footer a')).toBeNull();
  await view.unmount();
});

it('shows only the links whose URL is set', async () => {
  const view = await mountForm(
    <NoticeCard title="T" footerLinks={{ helpUrl: 'https://help.example.com/bos' }}>
      <p>Text</p>
    </NoticeCard>,
  );
  const links = [...document.querySelectorAll<HTMLAnchorElement>('footer a')];
  expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
    ['Need help?', 'https://help.example.com/bos'],
  ]);
  await view.unmount();

  const both = await mountForm(
    <NoticeCard
      title="T"
      footerLinks={{
        helpUrl: 'https://help.example.com',
        privacyUrl: 'https://example.com/privacy',
      }}
    >
      <p>Text</p>
    </NoticeCard>,
  );
  expect([...document.querySelectorAll('footer a')].map((a) => a.textContent)).toEqual([
    'Need help?',
    'Privacy',
  ]);
  await both.unmount();
});

it('hides the decorative panel from assistive technology and keeps it free of focusable content', async () => {
  const view = await mountForm(
    <NoticeCard title="T">
      <p>Text</p>
    </NoticeCard>,
  );
  const aside = document.querySelector('aside');
  expect(aside?.getAttribute('aria-hidden')).toBe('true');
  expect(aside?.querySelector('a, button, input, [tabindex]')).toBeNull();
  expect(document.querySelectorAll('h1')).toHaveLength(1);
  await view.unmount();
});

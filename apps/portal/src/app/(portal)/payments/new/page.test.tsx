import { defaultPortalDisplay } from '@bos/contracts';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callOf, json, session, stubPortalEnv } from '@/lib/billing-test-support';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { default: NewPaymentPage } = await import('./page');
const { PaymentForm } = await import('../_components/payment-form');

const fetchMock = vi.fn<typeof fetch>();

/** The props the page hands the form, found in the element tree it returns. */
function formProps(node: ReactNode): Parameters<typeof PaymentForm>[0] | undefined {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const found = formProps(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === PaymentForm) return el.props as unknown as Parameters<typeof PaymentForm>[0];
  return formProps(el.props.children);
}

const page = () => NewPaymentPage({ searchParams: Promise.resolve({}) });

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('NewPaymentPage', () => {
  it("hands the form the company's enabled currencies from the portal display read", async () => {
    fetchMock.mockResolvedValue(
      json({ ...defaultPortalDisplay(), enabledCurrencies: ['NPR', 'USD'] }),
    );
    const props = formProps(await page());
    expect(callOf(fetchMock).url).toBe('http://api:3001/v1/portal/display');
    expect(props?.enabledCurrencies).toEqual(['NPR', 'USD']);
    expect(props?.defaultCurrency).toBe('NPR');
  });

  it('falls back to the default list when the display read fails', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
    const props = formProps(await page());
    expect(props?.enabledCurrencies).toEqual(['NPR', 'INR', 'USD']);
  });
});

// @vitest-environment jsdom
// U1-20: the scan result of an upload is asked for after 500 ms, then 1 s, then every 2 s (it was every 2 s, first at 2 s).
import { createElement, act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { FileView } from '@/components/p2/crm/verification-file';
import { mountForm } from '@/test/form-interactions';

import { useDocumentScan } from './use-document-scan';

const DOC = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const quarantined: FileView = {
  documentId: DOC,
  versionId: VERSION,
  filename: 'a.pdf',
  sizeBytes: 10,
  mimeType: 'application/pdf',
  status: 'quarantined',
};

const fetchMock = vi.fn();
let result: ReturnType<typeof useDocumentScan> | undefined;
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

function Probe() {
  result = useDocumentScan('/api/scan', quarantined, true);
  return null;
}

function answer(status: FileView['status']) {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ ...quarantined, status }), { status: 200 })),
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  answer('quarantined');
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  result = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('asks at 500 ms, then 1 s later, then every 2 s', async () => {
  mounted = await mountForm(createElement(Probe));
  await advance(499);
  expect(fetchMock).not.toHaveBeenCalled();
  await advance(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await advance(999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await advance(1_999);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await advance(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it('shows the result at the first check when the scan has finished, and stops asking', async () => {
  answer('clean');
  mounted = await mountForm(createElement(Probe));
  await advance(500);
  expect(result?.file.status).toBe('clean');
  expect(result?.finished).toBe(true);
  await advance(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

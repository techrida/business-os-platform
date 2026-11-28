import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Locator, Request, Response } from '@playwright/test';

/** Times the final click (after actionability checks) to the caller's visible result.
 * Return false for an expected unsuccessful attempt that the spec will retry; thrown assertions stay thrown.
 * Only same-origin requests started and answered during that window contribute correlation IDs.
 */
export async function timeAction<T extends void | boolean>(
  name: string,
  button: Locator,
  expectResult: () => Promise<T>,
): Promise<T> {
  await button.click({ trial: true });
  const page = button.page();
  const origin = new URL(page.url()).origin;
  const requests = new Set<Request>();
  const requestIds = new Set<string>();
  const onRequest = (request: Request) => {
    if (new URL(request.url()).origin === origin) requests.add(request);
  };
  const onResponse = (response: Response) => {
    if (!requests.has(response.request())) return;
    const id = response.headers()['x-request-id'];
    if (id && /^[A-Za-z0-9-]{8,64}$/.test(id)) requestIds.add(id);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  let ok = false;
  const start = performance.now();
  try {
    await button.click();
    const result = await expectResult();
    ok = result !== false;
    return result;
  } finally {
    const pageMs = performance.now() - start;
    page.off('request', onRequest);
    page.off('response', onResponse);
    const file =
      process.env.BOS_QA_FLOW_TIMINGS_FILE ??
      path.resolve(__dirname, '../../../../.dev/qa-flow-timings.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ name, pageMs, ok, requestIds: [...requestIds] })}\n`);
  }
}

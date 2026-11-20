// Asks a same-origin route to put a PDF whose render was given up back in the render queue (round 4, R4c2: F1-Q13).
// The workspace's retry routes answer 202 when it was queued and 409 when it no longer needs a retry (another click,
// or the sweeper took it meanwhile); anything else, or no answer, is a failure the caller shows in the app.
export type PdfRetryOutcome = 'queued' | 'not-needed' | 'failed';

export async function requestPdfRetry(retryUrl: string): Promise<PdfRetryOutcome> {
  try {
    const response = await fetch(retryUrl, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    await response.body?.cancel();
    if (response.ok) return 'queued';
    return response.status === 409 ? 'not-needed' : 'failed';
  } catch {
    return 'failed';
  }
}

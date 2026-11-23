// Why a portal file route refused, in a header the document viewer reads. A status alone cannot tell a closed
// quotation (410, nothing to retry) from a download link that ran out (also 410, a new click fixes it).

export const DOCUMENT_STATE_HEADER = 'x-document-state';

export const DOCUMENT_STATES = ['expired', 'closed', 'not-found', 'error'] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export function documentStateOf(response: Pick<Response, 'headers'>): DocumentState | null {
  const value = response.headers.get(DOCUMENT_STATE_HEADER);
  return DOCUMENT_STATES.find((state) => state === value) ?? null;
}

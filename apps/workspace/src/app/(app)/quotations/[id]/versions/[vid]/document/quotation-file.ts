import { fetchSignedLink, signedFileResponse } from '@/lib/signed-file-route';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both endpoints read the customer PDF of one quotation version. `GET
 * /v1/quotations/:id/versions/:vid/document` issues a 60-second, single-use signed link and answers
 * 409 while the file is not clean and 404 when there is none, so each request issues exactly one.
 * The page offers the link only for a clean file, but the API is the one that refuses an unclean one.
 */
export async function quotationFileResponse(
  id: string,
  vid: string,
  mode: 'download' | 'preview',
): Promise<Response> {
  return signedFileResponse({
    mode,
    invalid: UUID.test(id) && UUID.test(vid) ? null : 'That is not a quotation id.',
    issueLink: (session) =>
      fetchSignedLink(
        session,
        `/v1/quotations/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/document`,
      ),
  });
}

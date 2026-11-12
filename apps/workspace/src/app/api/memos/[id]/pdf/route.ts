import { getMemo } from '@/lib/api-kernel';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';
import { memoPdfResponse } from '@/lib/memo-pdf-response';
import { memoPdfFileName } from '@/lib/memo-pdf';
import { memoPdfInputOf } from '@/lib/memo-pdf-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The saved memo as a real PDF: the persisted, frozen letterhead, signers, subject and body. The memo is read
 * through the API with the caller's own session, so the same scope check that opens the page decides here too; a
 * memo the caller cannot open is a 404 and no PDF. Nothing is stored or sent anywhere.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  if (!UUID.test(id)) return jsonResponse({ error: { message: 'That is not a memo id.' } }, 400);
  try {
    const memo = await getMemo(session, id);
    if (!memo.template) {
      return jsonResponse(
        { error: { message: 'This memo has no letterhead to export as a PDF.' } },
        409,
      );
    }
    return await memoPdfResponse(
      memoPdfInputOf(memo.template, memo.title, memo.body),
      memoPdfFileName(memo.number, memo.title),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

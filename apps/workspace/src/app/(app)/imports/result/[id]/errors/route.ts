import { ApiError } from '@/lib/api';
import { getImport } from '@/lib/api-imports';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

import { errorReportCsv } from '../../../_lib/import-view';

export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The error report of one import: a line per row that needs fixing or already exists, with its problems. It is read
 * from the stored record, so it matches the result page, and the API checks the grant of the batch's kind. Cells that
 * a spreadsheet would run as a formula are neutralised, because the text came from an uploaded file.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  if (!GUID.test(id)) return jsonResponse({ error: { message: 'That is not an import id.' } }, 404);
  try {
    const batch = await getImport(session, id.toLowerCase());
    return new Response(errorReportCsv(batch), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${batch.kind}-import-errors-${batch.id.slice(0, 8)}.csv"`,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404)
      return jsonResponse({ error: { message: 'Import not found.' } }, 404);
    return errorResponse(err);
  }
}

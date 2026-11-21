import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import { IMPORT_KINDS, importSlugOf, templateCsv } from '../../_lib/import-view';

export const dynamic = 'force-dynamic';

/** The CSV template of one kind: the header row and an example row. For people who may import that kind. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const slug = importSlugOf((await params).kind);
  if (slug === null)
    return jsonResponse({ error: { message: 'There is no import of that kind.' } }, 404);
  const meta = IMPORT_KINDS[slug];
  try {
    if (!hasGrant(await getGrants(session), meta.grant))
      return jsonResponse(
        { error: { message: `Your roles do not include importing ${meta.plural}.` } },
        403,
      );
  } catch (err) {
    return errorResponse(err);
  }
  return new Response(templateCsv(meta.kind), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${meta.plural}-import-template.csv"`,
      'x-content-type-options': 'nosniff',
    },
  });
}

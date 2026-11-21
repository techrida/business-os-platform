import { getSalesVatRegister, SalesVatPeriodSchema } from '@/lib/api-billing';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import { salesVatCsv } from '../../_lib/sales-vat-csv';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  // Live grants (GET /v1/me), as the register page is gated on, not the role defaults.
  if (!hasGrant(await getGrants(session), 'vat.sales.read'))
    return jsonResponse(
      { error: { message: 'Your roles do not include the sales VAT register.' } },
      403,
    );
  const params = new URL(req.url).searchParams;
  const period = SalesVatPeriodSchema.safeParse({ from: params.get('from'), to: params.get('to') });
  if (!period.success)
    return jsonResponse(
      {
        error: { message: 'Choose valid start and end dates, with the end on or after the start.' },
      },
      400,
    );
  try {
    const register = await getSalesVatRegister(session, period.data.from, period.data.to);
    return new Response(salesVatCsv(register), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="sales-vat-${period.data.from}-${period.data.to}.csv"`,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

import { getVatRegister, VatPeriodSchema } from '@/lib/api-payables';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import { vatCsv } from '../../_lib/vat-csv';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  // Live grants (GET /v1/me), as the register page is gated on, not the role defaults.
  if (!hasGrant(await getGrants(session), 'payables.vat_register.read'))
    return jsonResponse(
      { error: { message: 'Your roles do not include the purchase VAT register.' } },
      403,
    );
  const params = new URL(req.url).searchParams;
  const period = VatPeriodSchema.safeParse({ from: params.get('from'), to: params.get('to') });
  if (!period.success)
    return jsonResponse(
      {
        error: { message: 'Choose valid start and end dates, with the end on or after the start.' },
      },
      400,
    );
  try {
    const register = await getVatRegister(session, period.data.from, period.data.to);
    return new Response(vatCsv(register), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="purchase-vat-${period.data.from}-${period.data.to}.csv"`,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

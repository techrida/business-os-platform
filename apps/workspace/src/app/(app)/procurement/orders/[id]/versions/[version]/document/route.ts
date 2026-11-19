import { purchaseOrderFileResponse } from './po-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
): Promise<Response> {
  const { id, version } = await params;
  return purchaseOrderFileResponse(id, version, 'download');
}

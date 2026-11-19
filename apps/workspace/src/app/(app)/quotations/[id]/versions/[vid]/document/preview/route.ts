import { quotationFileResponse } from '../quotation-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
): Promise<Response> {
  const { id, vid } = await params;
  return quotationFileResponse(id, vid, 'preview');
}

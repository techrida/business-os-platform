import 'server-only';

import { loadMemoFonts } from './memo-pdf-fonts';
import { renderMemoPdf } from './memo-pdf';
import type { MemoPdfInput } from './memo-pdf-input';
import { jsonResponse } from './bff';

/** Renders the memo and wraps the bytes as a download. A font or render failure is a 500 with a plain message. */
export async function memoPdfResponse(input: MemoPdfInput, fileName: string): Promise<Response> {
  try {
    const { bytes, substituted } = await renderMemoPdf(input, await loadMemoFonts());
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${fileName}"`,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
        'x-memo-pdf-substituted': String(substituted),
      },
    });
  } catch {
    return jsonResponse({ error: { message: 'The PDF could not be made. Try again.' } }, 500);
  }
}

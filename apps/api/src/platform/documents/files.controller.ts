// The one download route: GET /v1/files/:token. Public on purpose (the signed link is the credential), so it
// must not call ctx(): there is no identity here. Serves NFR Security: a download is always an attachment,
// never sniffed or rendered by the browser, and sent as the type the server detected, not the one the client claimed.
import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator';
import { DocumentsService } from './documents.service';

/** RFC 6266: a safe ASCII fallback plus the exact UTF-8 name, so the header can never be broken out of. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

@Controller('v1/files')
export class FilesController {
  constructor(private readonly docs: DocumentsService) {}

  @Get(':token')
  @Public()
  async download(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.docs.openDownload(token);
    res.set({
      'Content-Type': file.mime,
      'Content-Disposition': contentDisposition(file.filename),
      'X-Content-Type-Options': 'nosniff',
      // Belt and braces if a browser ever rendered it: no scripts, no framing, nothing loaded.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
      'Content-Length': String(file.size),
    });
    return new StreamableFile(file.stream);
  }
}

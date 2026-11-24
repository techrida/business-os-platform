// The company logo for a reader with no session (R6Q20): the workspace and portal headers (through their same-origin
// proxies) and emails. Public on purpose and read-only: it can answer one kind of file, the live entity logo of the
// tenant named in the path, and nothing else (DocumentsService.openPublicLogo). It must not call ctx(): there is no
// identity here. The tenant id in the path is the tenant's public handle; what it serves is the logo the company
// profile names now, so the address never changes when the logo does and an old or unapplied logo is never public.
//   GET /v1/public/logo/:tenantId -> the bytes (inline, never sniffed), or 304 for a matching If-None-Match
import { pipeline } from 'node:stream/promises';

import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { Public } from '../../platform/auth/public.decorator';
import { DocumentsService } from '../../platform/documents/documents.service';

/**
 * Anyone may cache the logo, but only for five minutes: the address is stable while the logo behind it changes, so a
 * replaced or removed logo shows on the next revalidation (the ETag is the current version's id, so an unchanged
 * logo is a 304 with no body).
 */
export const PUBLIC_LOGO_CACHE_CONTROL = 'public, max-age=300';

@Controller('v1/public/logo')
export class PublicLogoController {
  constructor(private readonly docs: DocumentsService) {}

  @Get(':tenantId')
  @Public()
  async open(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ifNoneMatch = req.headers['if-none-match'];
    const image = await this.docs.openPublicLogo(
      tenantId,
      Array.isArray(ifNoneMatch) ? ifNoneMatch.join(', ') : ifNoneMatch,
    );
    res.set({
      ETag: `"${image.etag}"`,
      'Cache-Control': PUBLIC_LOGO_CACHE_CONTROL,
      // Another origin (an email client, a mail proxy) may show it; nothing else about the response is reusable.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (image.notModified) {
      res.status(304).end();
      return;
    }
    res.status(200).set({
      'Content-Type': image.mime,
      'Content-Length': String(image.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    try {
      await pipeline(image.stream, res);
    } catch {
      // The client went away or the file could not be read; pipeline has already destroyed both ends.
    }
  }
}

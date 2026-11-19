// Staff routes of images (U12, D33). Any signed-in staff principal may see the tenant's logos and profile pictures
// (no permission beyond being staff, checked in ImagesService), so both routes are @AnyAuthenticated; changing a
// picture is then checked per owner type in the service. Path ids are not parsed with ParseUUIDPipe: a malformed id
// is the same 404 as a missing one, never a 400.
//   GET /v1/images/:documentId               -> the bytes (inline, never sniffed), or 304 for a matching If-None-Match
//   PUT /v1/images/:ownerType/:ownerId       -> {documentId} after making that image current (null removes it)
//   POST /v1/images/:ownerType/:ownerId      -> 200 {documentId}: the raw body is the image, stored, queued for scanning and made
//                                               current in one request (Content-Type image/png|jpeg|webp, x-file-name)
import { pipeline } from 'node:stream/promises';

import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { requestTx } from '../../platform/db/tx';
import { currentPrincipal } from '../../platform/tenancy/request-context';
import { ImagesService, type ImageCaller } from './images.service';

/**
 * The browser may store the image but must revalidate it on every use: the bytes of an id never change, but who may
 * see them does (account switch, logout, access removed, entity changed). Revalidation sends the ETag (the version
 * id), so an unchanged picture is a cheap 304 that still runs every session and scope check. Never a max-age or
 * `immutable`: either lets the browser show a cached picture without asking, past those checks.
 */
export const IMAGE_CACHE_CONTROL = 'private, no-cache';

function caller(): ImageCaller {
  const { scope, actor } = requestTx();
  return { scope, actor, principal: currentPrincipal() };
}

/** A header as one string. Node joins a repeated custom header into one string, so the array branch is only typing. */
function singleHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The first If-None-Match header; Node joins repeated ones, so a string array never reaches here in practice. */
function ifNoneMatchOf(req: Request): string | undefined {
  const value = req.headers['if-none-match'];
  return Array.isArray(value) ? value.join(', ') : value;
}

@AnyAuthenticated()
@Controller('v1/images')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  /**
   * The image's bytes with its detected type. Not passthrough: Nest would overwrite a 304 with 200, so the
   * response is written here. A storage error while streaming ends the response (the headers are already sent).
   */
  @Get(':documentId')
  async open(
    @Param('documentId') documentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const image = await this.images.open(caller(), documentId, ifNoneMatchOf(req));
    res.set({ ETag: `"${image.etag}"`, 'Cache-Control': IMAGE_CACHE_CONTROL });
    if (image.notModified) {
      res.status(304).end();
      return;
    }
    res.status(200).set({
      'Content-Type': image.mime,
      'Content-Length': String(image.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    try {
      await pipeline(image.stream, res);
    } catch {
      // The client went away or the file could not be read; pipeline has already destroyed both ends.
    }
  }

  /** `{documentId: uuid | null}` -> 200 `{documentId}`. See ImagesService.set for every refusal. */
  @Put(':ownerType/:ownerId')
  set(
    @Param('ownerType') ownerType: string,
    @Param('ownerId') ownerId: string,
    @Body() body: unknown,
  ): Promise<{ documentId: string | null }> {
    return this.images.set(caller(), ownerType, ownerId, body);
  }

  /**
   * Raw upload: the request body IS the image, so the handler hands the request stream to the service and nothing
   * buffers it here. The global JSON and urlencoded parsers only act on those two content types, so an image/* body
   * reaches the service unread; a JSON or form body is refused by the service's type check (415) before it reads.
   * See ImagesService.upload for the check order and every refusal.
   */
  @Post(':ownerType/:ownerId')
  @HttpCode(200)
  upload(
    @Param('ownerType') ownerType: string,
    @Param('ownerId') ownerId: string,
    @Req() req: Request,
  ): Promise<{ documentId: string }> {
    return this.images.upload(
      ownerType,
      ownerId,
      {
        contentType: singleHeader(req, 'content-type'),
        contentLength: singleHeader(req, 'content-length'),
        fileNameHeader: singleHeader(req, 'x-file-name'),
        stream: req,
      },
      caller(),
    );
  }
}

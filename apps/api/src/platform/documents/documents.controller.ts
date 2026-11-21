// HTTP routes for documents (authenticated). Serves NFR Security: every upload route names its permission with
// @Can, the upload is a raw streamed PUT with two size caps, and nothing here ever serves file bytes
// (downloads go through the signed-link route in files.controller.ts). The two read routes carry
// @AnyAuthenticated because no single permission fits: `documents.read` or an owner type's own read permission
// (`verification.review` for case files, `vendor.read` for vendor files) opens a file. Their first statement is the
// grant check (DocumentsService.assertReadRoute), before the id is parsed or any row is read, and the record check
// on the document's owner still follows.
import {
  CreateDocumentBodySchema,
  type DocumentVersionDto,
  type SignedLinkDto,
} from '@bos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { AnyAuthenticated, Can } from '../authz/decorators';
import { DB, type Db } from '../db/db.module';
import { requestTx, withTx } from '../db/tx';
import { DocumentsService, ScanQueueDeferredError, type DocumentDto } from './documents.service';

const Id = z.guid();

/** A new version names only the file: the owner and the document already exist. */
const NewVersionBodySchema = CreateDocumentBodySchema.pick({
  filename: true,
  declaredMime: true,
  sizeBytes: true,
});

/** Field names only: echoing values back would reflect attacker-controlled text. */
function invalidFields(error: z.ZodError, what: string): BadRequestException {
  const fields = [...new Set(error.issues.map((i) => i.path.join('.') || 'body'))];
  return new BadRequestException(`Invalid ${what}: ${fields.join(', ')}`);
}

/** 411 Length Required. The body is streamed, so the size must be announced up front. */
export class LengthRequiredException extends HttpException {
  constructor() {
    super('Content-Length is required for an upload', 411);
  }
}

/** The Content-Length header as a number; 411 when missing, 400 when it is not a plain integer. */
export function parseContentLength(header: string | undefined): number {
  if (header === undefined) throw new LengthRequiredException();
  if (!/^\d{1,12}$/.test(header))
    throw new BadRequestException('Content-Length is not a valid number');
  return Number(header);
}

function idOrBadRequest(value: string, name: string): string {
  if (!Id.safeParse(value).success) throw new BadRequestException(`${name} must be a UUID`);
  return value;
}

@Controller('v1/documents')
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Post()
  @Can('documents.upload')
  async create(
    @Body() body: unknown,
  ): Promise<{ documentId: string; versionId: string; uploadPath: string }> {
    const parsed = CreateDocumentBodySchema.safeParse(body);
    if (!parsed.success) throw invalidFields(parsed.error, 'document');
    const { scope, actor } = requestTx();
    // Not `create`: a picture (an image owner type) is a 409 here, it is uploaded through POST /v1/images.
    return withTx(this.db, scope, actor, (tx) => this.docs.createFromRequest(tx, parsed.data));
  }

  /**
   * A new version of an existing document. Works on top of an infected or failed one: the way out of it.
   * A picture is a 409: a new picture is a new document, uploaded through POST /v1/images.
   */
  @Post(':id/versions')
  @Can('documents.upload')
  async createVersion(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ documentId: string; versionId: string; uploadPath: string }> {
    idOrBadRequest(id, 'id');
    const parsed = NewVersionBodySchema.safeParse(body);
    if (!parsed.success) throw invalidFields(parsed.error, 'version');
    const { scope, actor } = requestTx();
    return withTx(this.db, scope, actor, (tx) => this.docs.createVersion(tx, id, parsed.data));
  }

  /** Soft remove. Same permission as the upload; the owner's canAttach decides whether it is still allowed. */
  @Delete(':id')
  @Can('documents.upload')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    idOrBadRequest(id, 'id');
    await this.docs.remove(id);
  }

  /**
   * Raw upload: the request body IS the file, so the handler gets the request stream and nothing buffers it.
   * The global JSON and urlencoded parsers only act on those two content types, so send the file with its
   * own type (for example application/pdf) and they leave the stream alone.
   */
  @Put(':id/versions/:versionId/content')
  @Can('documents.upload')
  async upload(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentVersionDto> {
    idOrBadRequest(id, 'id');
    idOrBadRequest(versionId, 'versionId');
    const length = parseContentLength(req.headers['content-length']);
    if (req.readableEnded) {
      // A body parser already consumed the stream: the client sent the file as application/json or a form.
      throw new UnsupportedMediaTypeException(
        'Send the file with its own Content-Type (for example application/pdf), not as JSON or a form',
      );
    }
    try {
      return await this.docs.receiveContent(versionId, req, length, { documentId: id });
    } catch (error) {
      // Received and kept; only the scan is waiting for the queue (the sweeper queues it): accepted, not done.
      if (!(error instanceof ScanQueueDeferredError)) throw error;
      res.status(202);
      return error.version;
    }
  }

  @Get(':id')
  @AnyAuthenticated()
  get(@Param('id') id: string): Promise<DocumentDto> {
    this.docs.assertReadRoute();
    idOrBadRequest(id, 'id');
    return this.docs.get(requestTx().scope, id);
  }

  @Post(':id/versions/:versionId/link')
  @AnyAuthenticated()
  @HttpCode(200)
  link(@Param('id') id: string, @Param('versionId') versionId: string): Promise<SignedLinkDto> {
    this.docs.assertReadRoute();
    idOrBadRequest(id, 'id');
    idOrBadRequest(versionId, 'versionId');
    return this.docs.issueLink(requestTx().scope, versionId, id);
  }
}

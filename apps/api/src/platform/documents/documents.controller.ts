// HTTP routes for documents (authenticated). Serves NFR Security: every route names its permission with
// @Can, the upload is a raw streamed PUT with two size caps, and nothing here ever serves file bytes
// (downloads go through the signed-link route in files.controller.ts).
import {
  CreateDocumentBodySchema,
  type DocumentVersionDto,
  type SignedLinkDto,
} from '@bos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { Can } from '../authz/decorators';
import { DB, type Db } from '../db/db.module';
import { requestTx, withTx } from '../db/tx';
import { DocumentsService, type DocumentDto } from './documents.service';

const Id = z.guid();

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
    if (!parsed.success) {
      // Field names only: echoing values back would reflect attacker-controlled text.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))];
      throw new BadRequestException(`Invalid document: ${fields.join(', ')}`);
    }
    const { scope, actor } = requestTx();
    return withTx(this.db, scope, actor, (tx) => this.docs.create(tx, parsed.data));
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
    return this.docs.receiveContent(versionId, req, length, { documentId: id });
  }

  @Get(':id')
  @Can('documents.read')
  get(@Param('id') id: string): Promise<DocumentDto> {
    idOrBadRequest(id, 'id');
    return this.docs.get(requestTx().scope, id);
  }

  @Post(':id/versions/:versionId/link')
  @Can('documents.read')
  @HttpCode(200)
  link(@Param('id') id: string, @Param('versionId') versionId: string): Promise<SignedLinkDto> {
    idOrBadRequest(id, 'id');
    idOrBadRequest(versionId, 'versionId');
    return this.docs.issueLink(requestTx().scope, versionId, id);
  }
}

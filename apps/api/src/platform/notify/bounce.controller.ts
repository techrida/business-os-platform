// POST /v1/hooks/postal: the receiving end of Postal's bounce webhook.
// Serves the Reliability NFR (a bounced address is marked, not retried forever) and the Security NFR
// ("no unauthenticated write path"). It is @Public because Postal holds no user token, so the HMAC
// signature is its authentication: no secret configured, or no valid signature, answers 401.
// Same shape as the ZITADEL hook (users/hooks.controller.ts), and it needs the raw bytes the same way
// (main.ts turns on rawBody).
//
// Authentic events we do not act on answer 204 too, so Postal does not retry them. A store failure is
// NOT swallowed: the 500 makes Postal retry, and marking a bounce twice is harmless.
import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { ZodError } from 'zod';

import { Public } from '../auth/public.decorator';
import { AppConfig } from '../config/config';
import { BounceService, verifyPostalSignature } from './bounce.service';

/** Header carrying the hex HMAC-SHA256 of the raw body (see verifyPostalSignature for the scheme). */
export const SIGNATURE_HEADER = 'x-postal-signature';

type HookRequest = RawBodyRequest<IncomingMessage & { body?: unknown }>;

@Controller('v1/hooks')
export class BounceController {
  constructor(
    private readonly config: AppConfig,
    private readonly bounces: BounceService,
  ) {}

  @Public()
  @Post('postal')
  @HttpCode(204)
  async postal(@Req() req: HookRequest): Promise<void> {
    const secret = this.config.POSTAL_WEBHOOK_SECRET;
    const header = req.headers[SIGNATURE_HEADER];
    // Fail closed: no secret configured means no request can be authentic.
    if (
      !secret ||
      typeof header !== 'string' ||
      !req.rawBody ||
      !verifyPostalSignature(req.rawBody, header, secret)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let body: unknown;
    try {
      body = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Webhook body is not JSON');
    }
    try {
      await this.bounces.handle(body);
    } catch (error) {
      // Field names only: the body is attacker-shaped until the signature check above, and Postal's
      // payload carries addresses we never echo.
      if (error instanceof ZodError) throw new BadRequestException('Webhook body is not an event');
      throw error;
    }
  }
}

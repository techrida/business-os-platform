// The email delivery log routes (Settings > Email delivery, F1-Q15). Reading needs email_delivery.read and
// resending needs email_delivery.resend; both are Founder-only by default. The service scopes every query to
// the caller's tenant and organization, so another tenant's id answers 404.
import {
  type EmailDeliveryPage,
  EmailDeliveryFilterSchema,
  type EmailResendResult,
} from '@bos/contracts';
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

import { Can } from '../authz/decorators';
import { DeliveryLogService } from './delivery-log.service';

const ListQuery = z.object({
  filter: EmailDeliveryFilterSchema.default('failed'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.guid().optional(),
});

@Controller('v1/admin/email-deliveries')
export class DeliveryLogController {
  constructor(private readonly deliveries: DeliveryLogService) {}

  @Get()
  @Can('email_delivery.read')
  list(@Query() query: unknown): Promise<EmailDeliveryPage> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) {
      // Field names only: echoing values back would reflect caller-controlled text.
      const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
      throw new BadRequestException(`Invalid query: ${fields.join(', ')}`);
    }
    return this.deliveries.list(parsed.data);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @Can('email_delivery.resend')
  resend(@Param('id', ParseUUIDPipe) id: string): Promise<EmailResendResult> {
    return this.deliveries.resend(id);
  }
}

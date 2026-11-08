// The bell and inbox routes. Every route is @AnyAuthenticated: a notification belongs to its user, so the
// rule is "your own rows only" (enforced in NotifyService by the principal's user id), not a permission.
// Serves the Security NFR: another user's notification id answers 404, never 403, so ids stay unconfirmed.
import type { NotificationDto, UnreadCountDto } from '@bos/contracts';
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

import { AnyAuthenticated } from '../authz/decorators';
import { NotifyService } from './notify.service';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.guid().optional(),
});

/** Field names only in the message: echoing values back would reflect caller-controlled text. */
function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new BadRequestException(`Invalid ${what}: ${fields.join(', ')}`);
  }
  return parsed.data;
}

@Controller('v1/notifications')
export class NotifyController {
  constructor(private readonly notify: NotifyService) {}

  @Get()
  @AnyAuthenticated()
  list(@Query() query: unknown): Promise<NotificationDto[]> {
    const q = parse(ListQuery, query, 'query');
    return this.notify.listMine(q.limit, q.before);
  }

  @Get('unread-count')
  @AnyAuthenticated()
  async unreadCount(): Promise<UnreadCountDto> {
    return { count: await this.notify.unreadCount() };
  }

  @Post(':id/read')
  @HttpCode(204)
  @AnyAuthenticated()
  async markRead(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.notify.markRead(id);
  }
}

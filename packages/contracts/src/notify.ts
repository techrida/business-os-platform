// What the workspace bell and inbox read. Fields follow app.notifications in section 4.
import { z } from 'zod';

export const NotificationDtoSchema = z.object({
  id: z.guid(),
  title: z.string(),
  body: z.string(),
  /** A workspace path such as /inbox/<id>; never an absolute URL with a token in it. */
  link: z.string(),
  readAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type NotificationDto = z.infer<typeof NotificationDtoSchema>;

export const UnreadCountDtoSchema = z.object({ count: z.number().int().nonnegative() });
export type UnreadCountDto = z.infer<typeof UnreadCountDtoSchema>;

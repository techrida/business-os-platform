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

// --- Email delivery log (Settings > Email delivery, F1-Q15) ---

/**
 * How one outbox email stands, in the words the log shows. `failed`: out of retries. `bounced`: the mail
 * server took it but it bounced back, or it was stopped because the address bounced before. Only those two
 * can be resent.
 */
export const EMAIL_DELIVERY_STATES = ['queued', 'sending', 'delivered', 'failed', 'bounced'] as const;
export const EmailDeliveryStateSchema = z.enum(EMAIL_DELIVERY_STATES);
export type EmailDeliveryState = z.infer<typeof EmailDeliveryStateSchema>;

/** Which rows the log lists: only the ones that need attention, or every email. */
export const EmailDeliveryFilterSchema = z.enum(['failed', 'all']);
export type EmailDeliveryFilter = z.infer<typeof EmailDeliveryFilterSchema>;

export const EmailDeliveryDtoSchema = z.object({
  id: z.guid(),
  /** The template key, for example `approval.pending`. */
  template: z.string(),
  recipient: z.string(),
  subject: z.string(),
  state: EmailDeliveryStateSchema,
  /** Send attempts since the email was queued or last resent. */
  attempts: z.number().int().nonnegative(),
  /** How many times someone resent it. */
  resendCount: z.number().int().nonnegative(),
  /** The last failure, already redacted by the sender; null when there is none. */
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  canResend: z.boolean(),
});
export type EmailDeliveryDto = z.infer<typeof EmailDeliveryDtoSchema>;

export const EmailDeliveryPageSchema = z.object({
  items: z.array(EmailDeliveryDtoSchema),
  /** Pass as `before` to read the next (older) page; null on the last page. */
  nextBefore: z.guid().nullable(),
});
export type EmailDeliveryPage = z.infer<typeof EmailDeliveryPageSchema>;

/** `queued`: this call put the email back in the queue. `already_queued`: it was already waiting or sending. */
export const EmailResendResultSchema = z.object({
  outcome: z.enum(['queued', 'already_queued']),
});
export type EmailResendResult = z.infer<typeof EmailResendResultSchema>;

// The SQL behind the Postal bounce webhook (the BounceStore in bounce.service.ts).
// Serves the Reliability NFR: a hard-bounced address stops receiving the emails still waiting for it.
//
// app.outbox has no column or status for "bounced" (its status CHECK allows pending, sending, sent, dead
// only, and a schema change is a migration, which this unit does not own). So a bounce is recorded in what
// exists today: the row that carried the message gets last_error = 'bounced (hard|soft)', and for a hard
// bounce the still-pending rows for the same recipient in the same tenant become `dead`. Nothing yet stops
// a NEW email being queued for that address; that needs a persistent flag on the recipient (see the
// hand-back for the migration that adds it).
//
// The tenant comes from the matched outbox row, never from the webhook payload. Like the drainer, this
// reads app.outbox across tenants (the table has no row-level security), so it runs with no tenant scope.
import { outbox } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { DB, type Db, inTransaction } from '../db/db.module';
import { type BounceMark, BounceStore } from './bounce.service';

@Injectable()
export class SqlBounceStore extends BounceStore {
  constructor(@Inject(DB) private readonly db: Db) {
    super();
  }

  async markBounced({ messageId, kind }: BounceMark): Promise<number> {
    return inTransaction(this.db, async (tx) => {
      // nodemailer returns the Message-ID with angle brackets and Postal reports it without: match both.
      const matched = await tx
        .update(outbox)
        .set({ lastError: `bounced (${kind})` })
        .where(inArray(outbox.providerMessageId, [messageId, `<${messageId}>`]))
        .returning({ tenantId: outbox.tenantId, toEmail: outbox.toEmail });

      if (kind === 'hard') {
        const recipients = new Map(
          matched.map((r) => [`${r.tenantId}\n${r.toEmail.toLowerCase()}`, r] as const),
        );
        for (const r of recipients.values()) {
          await tx
            .update(outbox)
            .set({ status: 'dead', claimedAt: null, lastError: 'recipient bounced' })
            .where(
              and(
                eq(outbox.tenantId, r.tenantId),
                sql`lower(${outbox.toEmail}) = ${r.toEmail.toLowerCase()}`,
                eq(outbox.status, 'pending'),
              ),
            );
        }
      }
      return matched.length;
    });
  }
}

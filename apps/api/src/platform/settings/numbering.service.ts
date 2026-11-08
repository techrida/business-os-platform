// Gap-free document numbers such as MEMO-2082/83-00001. Serves the finance NFR "no gaps in a numbered series".
//
// Why not a Postgres SEQUENCE: nextval() is deliberately outside transactions. A rolled-back transaction
// has already consumed its number and nobody gets it back, so the series would show holes. An auditor asks
// "where is invoice 17?" and the honest answer would be "a request failed once".
//
// Instead each (tenant, organization, series, fiscal year) has one counter row in app.number_series, and
// next() runs `UPDATE ... SET next_value = next_value + 1` inside the caller's business transaction. That
// UPDATE takes a row lock that is held until COMMIT or ROLLBACK:
//   - a concurrent caller waits on the lock, so two documents can never receive the same number;
//   - on ROLLBACK the increment is undone with the rest of the transaction, so the number is handed out again.
// The cost is that two documents of the same series cannot be created at the exact same moment. That is
// what "gap-free" means, and the lock lasts only as long as one business transaction.
import { fiscalYearOf } from '@bos/locale';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DbTransaction } from '../db/db.module';

@Injectable()
export class NumberingService {
  /**
   * Takes the next number of `seriesKey` for the fiscal year that contains `at`, e.g. `MEMO-2082/83-00001`.
   * Scope comes from the transaction (set by withTx), never from the request: the worker has no request.
   * The number is only real once `tx` commits; if it rolls back, the next call returns the same number.
   */
  async next(tx: DbTransaction, seriesKey: string, at: Date): Promise<string> {
    const scope = await tx.execute<{ tenant_id: string | null; organization_id: string | null }>(
      sql`SELECT current_setting('bos.tenant_id', true) AS tenant_id,
                 current_setting('bos.organization_id', true) AS organization_id`,
    );
    const tenantId = scope.rows[0]?.tenant_id;
    const organizationId = scope.rows[0]?.organization_id;
    // Unset gives NULL; a setting that was set and then reverted at COMMIT gives ''.
    if (!tenantId || !organizationId) {
      throw new Error(
        'NumberingService.next needs a transaction opened with withTx: bos.tenant_id and bos.organization_id are not set',
      );
    }

    const fy = fiscalYearOf(at);

    // First use of a series in a fiscal year creates its counter row. DO NOTHING (not DO UPDATE) so that a
    // caller who loses the race does not touch, and so does not lock, the winner's row here.
    await tx.execute(sql`
      INSERT INTO app.number_series (tenant_id, organization_id, key, fiscal_year, prefix)
      VALUES (${tenantId}, ${organizationId}, ${seriesKey}, ${fy}, ${seriesKey})
      ON CONFLICT (tenant_id, organization_id, key, fiscal_year) DO NOTHING`);

    // The row lock is taken here and kept until the caller's transaction ends.
    const result = await tx.execute<{ n: string; prefix: string; pad: number }>(sql`
      UPDATE app.number_series
         SET next_value = next_value + 1
       WHERE tenant_id = ${tenantId}
         AND organization_id = ${organizationId}
         AND key = ${seriesKey}
         AND fiscal_year = ${fy}
      RETURNING next_value - 1 AS n, prefix, pad`);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`number series ${seriesKey} ${fy} vanished between insert and update`);
    }
    // bigint comes back from pg as a string; document counters stay far below 2^53.
    return `${row.prefix}-${fy}-${String(row.n).padStart(row.pad, '0')}`;
  }
}

// The daily KYC expiry check of vendors (worker side). It needs only the database and AuditService, so the worker
// can import VendorsWorkerModule without VendorsService, VerificationService or DocumentsModule.
import { organizations, vendors } from '@bos/db';
import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { AuditModule } from '../../platform/audit/audit.module';
import { AuditService } from '../../platform/audit/audit.service';
import { DB, type Db } from '../../platform/db/db.module';
import { updateVersioned } from '../../platform/db/idempotency';
import { systemActor, withTx } from '../../platform/db/tx';
import { kybCaseOf, lockVendor } from './vendors.queries';
import { isoDay, lapsedTaxClearance } from './vendors.rules';

/** Injection token for a test clock; production falls back to the system time. */
export const VENDOR_KYC_EXPIRY_CLOCK = Symbol('VENDOR_KYC_EXPIRY_CLOCK');

@Injectable()
export class VendorKycExpiryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    @Optional()
    @Inject(VENDOR_KYC_EXPIRY_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * The daily KYC expiry check: every approved vendor whose KYB case holds a tax clearance with `expiresOn`
   * before `today` becomes `suspended`, under the system actor, in the default entity of its tenant. No request
   * context is read, so a scheduler (a BullMQ repeatable job in the worker) can call it. Returns the vendor ids.
   */
  async run(now: Date = this.clock()): Promise<{ suspended: string[] }> {
    const today = isoDay(now);
    const candidates = await this.db.execute<{ tenant_id: string; id: string }>(sql`
      SELECT v.tenant_id, v.id
        FROM app.vendors v
        JOIN app.verification_cases c ON c.tenant_id = v.tenant_id AND c.party_id = v.id
       WHERE v.status = 'approved'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(c.checklist) i
            WHERE i->>'key' = 'tax_clearance' AND i->>'expiresOn' < ${today})
       ORDER BY v.tenant_id, v.id`);
    const suspended: string[] = [];
    for (const c of candidates.rows) {
      const [entity] = await this.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.tenantId, c.tenant_id), eq(organizations.isDefault, true)))
        .limit(1);
      if (entity === undefined) continue;
      const done = await withTx(
        this.db,
        { tenantId: c.tenant_id, organizationId: entity.id },
        systemActor('vendors.kyc-expiry'),
        async (tx) => {
          const row = await lockVendor(tx, c.tenant_id, c.id);
          // Re-read under the lock: it may have been suspended, blocked or renewed since the scan.
          if (row === undefined || row.status !== 'approved') return false;
          const kyb = await kybCaseOf(tx, c.tenant_id, c.id);
          if (kyb === undefined || !lapsedTaxClearance(kyb.items, today)) return false;
          await updateVersioned(tx, vendors, row.id, row.version, {
            status: 'suspended',
            updatedAt: now,
          });
          await this.audit.record(tx, {
            action: 'vendor.suspended',
            entityType: 'vendor',
            entityId: row.id,
            before: { status: 'approved' },
            after: { status: 'suspended', reason: 'tax_clearance_expired' },
          });
          return true;
        },
      );
      if (done) suspended.push(c.id);
    }
    return { suspended };
  }
}

@Module({
  imports: [AuditModule],
  providers: [VendorKycExpiryService],
  exports: [VendorKycExpiryService],
})
export class VendorsWorkerModule {}

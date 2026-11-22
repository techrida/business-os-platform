// The customer and vendor CSV import (round 5, K1; Kuu decision K-M3).
//   preview  parses the upload, checks every line, marks the lines that duplicate an existing record or an earlier
//            line, and stores the result as a `previewed` batch (party_import_batches). Nothing else is written.
//   (a preview left uncommitted for 7 days is `expired` and its rows cleared by the worker, see party-import-expiry.sweeper)
//   commit   creates the valid lines of a batch in ONE transaction (customer through CustomersService.createInTx and
//            its first contact; vendor through VendorsService.createInTx, status `draft` like a hand-created one),
//            then marks the batch `committed` with its counts. The importer is the actor of every audited row.
// Idempotent by construction: a line is keyed on its PAN when it has one, otherwise on its normalised name, and a key
// that already exists in the tenant is a duplicate that is skipped, so uploading the same file again creates nothing.
// A committed batch is returned as it is when committed again. Concurrent commits of one tenant and kind queue on an
// advisory lock, so two batches cannot both pass the name check for the same company.
// Tenancy: every lookup is by the caller's tenant; another tenant's PAN neither matches nor is revealed. The file is
// never stored (no bucket, no document row): only what was read from it is kept in the batch record.
import {
  CountryCodeSchema,
  parsePhonesCell,
  PartyImportRowSchema,
  PARTY_IMPORT_MAX_BYTES,
  type PartyImportBatch,
  type PartyImportDetail,
  type PartyImportKind,
  type PartyImportRow,
} from '@bos/contracts';
import { customers, partyImportBatches, scoped, vendors } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { READ_ONLY, withTx, type TxScope } from '../../platform/db/tx';
import { CustomersService } from '../customers/customers.service';
import { VendorsService } from '../vendors/vendors.service';
import { PartyImportsCaller } from './party-imports.caller';
import {
  buildRows,
  countStatuses,
  identityKey,
  PartyImportFileError,
  readPartyCsv,
} from './party-import.rules';

/** Injection token for a test clock; production falls back to the system time. */
export const PARTY_IMPORTS_CLOCK = Symbol('PARTY_IMPORTS_CLOCK');

type BatchRow = typeof partyImportBatches.$inferSelect;

const RowsSchema = z.array(PartyImportRowSchema);
const ALREADY_EXISTS = 'Already exists in this company, so it is skipped';

const toBatch = (row: BatchRow): PartyImportBatch => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  fileName: row.fileName,
  rowCount: row.rowCount,
  validCount: row.validCount,
  createdCount: row.createdCount,
  duplicateCount: row.duplicateCount,
  errorCount: row.errorCount,
  createdByUserId: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  committedAt: row.committedAt?.toISOString() ?? null,
});

/** The result page's rows: the normalised values stay in the record, they are not sent back. */
const toDetail = (row: BatchRow): PartyImportDetail => ({
  ...toBatch(row),
  rows: RowsSchema.parse(row.rows).map(({ values: _values, ...rest }) => rest),
});

/**
 * The phones of a stored line: the canonical cell `checkPartyImportPlace` wrote at preview, read again. A cell that no
 * longer parses is a broken batch, never a contact silently saved without its numbers.
 */
const storedPhones = (cell: string | undefined) => {
  const parsed = parsePhonesCell(cell ?? '');
  if (!parsed.ok) throw new Error(`A stored import line has unreadable phones: ${parsed.message}`);
  return parsed.phones;
};

const batchNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Import not found' });

@Injectable()
export class PartyImportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly caller: PartyImportsCaller,
    private readonly customersService: CustomersService,
    private readonly vendorsService: VendorsService,
    private readonly audit: AuditService,
    @Optional() @Inject(PARTY_IMPORTS_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Staff only, and the same grant a person needs to create one such record by hand (in the acting entity). */
  private assertMay(kind: PartyImportKind): void {
    const { scope, principal } = this.caller.current();
    this.assertStaff(principal);
    if (kind === 'customer')
      this.authz.assert('customer.write', {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      });
    else this.authz.assert('vendor.write');
  }

  private mayList(kind: PartyImportKind): boolean {
    try {
      this.assertMay(kind);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  private assertStaff(p: Principal): void {
    if (p.orgKind !== 'staff')
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
  }

  // ------------------------------------------------------------------------------------------------ preview

  async preview(kind: PartyImportKind, fileName: string, csv: string): Promise<PartyImportDetail> {
    const { scope, actor } = this.caller.current();
    this.assertMay(kind);
    if (Buffer.byteLength(csv, 'utf8') > PARTY_IMPORT_MAX_BYTES)
      throw new PayloadTooLargeException({
        code: 'payload_too_large',
        message: 'The file is larger than 2 MB',
      });
    let rows: PartyImportRow[];
    try {
      rows = buildRows(kind, readPartyCsv(kind, csv).records);
    } catch (error) {
      if (error instanceof PartyImportFileError)
        throw new BadRequestException({
          code: 'bad_request',
          reason: 'import_file_invalid',
          message: error.message,
        });
      throw error;
    }
    return withTx(this.db, scope, actor, async (tx) => {
      rows = await this.markExisting(tx, scope, kind, rows);
      const [row] = await tx
        .insert(partyImportBatches)
        .values({
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          kind,
          status: 'previewed',
          fileName,
          ...countStatuses(rows),
          rows,
          createdBy: actor.id,
          createdAt: this.clock(),
        })
        .returning();
      await this.audit.record(tx, {
        action: 'party_import.previewed',
        entityType: 'party_import_batch',
        entityId: row!.id,
        after: { kind, fileName, ...countStatuses(rows) },
      });
      return toDetail(row!);
    });
  }

  // ------------------------------------------------------------------------------------------------- commit

  async commit(batchId: string): Promise<PartyImportDetail> {
    const { scope, actor } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const [batch] = await tx
        .select()
        .from(partyImportBatches)
        .where(scoped(scope).where(partyImportBatches, eq(partyImportBatches.id, batchId)))
        .for('update');
      if (batch === undefined) throw batchNotFound();
      this.assertMay(batch.kind);
      if (batch.status === 'committed') return toDetail(batch);
      // An expired preview holds no rows any more (migration 0185): there is nothing to create.
      if (batch.status === 'expired')
        throw new ConflictException({
          code: 'conflict',
          message:
            'This preview expired after 7 days without being imported. Upload the file again.',
        });
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`party-import:${scope.tenantId}:${batch.kind}`}, 0))`,
      );
      // Records may have been added since the preview: look again, at the moment of the write.
      let rows = await this.markExisting(tx, scope, batch.kind, RowsSchema.parse(batch.rows));
      rows = await this.createValid(tx, batch.kind, rows, now);
      const counts = countStatuses(rows);
      const [updated] = await tx
        .update(partyImportBatches)
        .set({
          status: 'committed',
          ...counts,
          rows,
          committedBy: actor.id,
          committedAt: now,
        })
        // The same tenant and entity scope as the read above, and still a preview, as well as the id.
        .where(
          scoped(scope).where(
            partyImportBatches,
            and(eq(partyImportBatches.id, batch.id), eq(partyImportBatches.status, 'previewed')),
          ),
        )
        .returning();
      await this.audit.record(tx, {
        action: 'party_import.committed',
        entityType: 'party_import_batch',
        entityId: batch.id,
        after: { kind: batch.kind, fileName: batch.fileName, ...counts },
      });
      return toDetail(updated!);
    });
  }

  private async createValid(
    tx: DbTransaction,
    kind: PartyImportKind,
    rows: PartyImportRow[],
    now: Date,
  ): Promise<PartyImportRow[]> {
    const { scope } = this.caller.current();
    const out: PartyImportRow[] = [];
    const nameIndex =
      kind === 'vendor' && rows.some((r) => r.status === 'valid')
        ? await this.vendorsService.nameIndex(tx, scope.tenantId)
        : undefined;
    for (const row of rows) {
      if (row.status !== 'valid' || row.values === undefined) {
        out.push(row);
        continue;
      }
      const v = row.values;
      let recordId: string;
      if (kind === 'customer') {
        const customer = await this.customersService.createInTx(
          tx,
          scope,
          {
            legalName: v.legal_name!,
            ...(v.pan_vat_no ? { panVatNo: v.pan_vat_no } : {}),
            ...(v.industry ? { industry: v.industry } : {}),
            relationship: 'prospect',
            country: CountryCodeSchema.parse(v.address_country),
            address: { line: v.address_line!, city: v.address_city! },
          },
          now,
        );
        await this.customersService.createContactInTx(
          tx,
          scope,
          customer.id,
          {
            fullName: v.contact_name || v.legal_name!,
            email: v.contact_email!,
            country: CountryCodeSchema.parse(v.contact_country),
            // The first number of the cell is the primary one (parsePhonesCell).
            phones: storedPhones(v.contact_phones),
            isPrimary: true,
          },
          now,
        );
        recordId = customer.id;
      } else {
        const hasContact = v.contact_name !== '' && v.contact_name !== undefined;
        const country = CountryCodeSchema.parse(v.country);
        const vendor = await this.vendorsService.createInTx(
          tx,
          {
            legalName: v.legal_name!,
            kind: v.kind as 'company' | 'sole_proprietor' | 'individual' | 'foreign',
            ...(v.pan ? { pan: v.pan } : {}),
            vatRegistered: v.vat_registered === 'yes',
            country,
            // Line and city come together or not at all (checkPartyImportPlace).
            ...(v.address_line ? { address: { line: v.address_line, city: v.address_city! } } : {}),
          },
          now,
          hasContact
            ? {
                name: v.contact_name!,
                ...(v.contact_email ? { email: v.contact_email } : {}),
                // The template has no contact country: the contact is placed in the vendor's country.
                country,
                phones: storedPhones(v.contact_phone),
              }
            : undefined,
          nameIndex,
        );
        recordId = vendor.id;
      }
      out.push({ ...row, status: 'created', recordId });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- reads

  async get(batchId: string): Promise<PartyImportDetail> {
    const { scope, actor } = this.caller.current();
    const row = await withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const [found] = await tx
          .select()
          .from(partyImportBatches)
          .where(scoped(scope).where(partyImportBatches, eq(partyImportBatches.id, batchId)));
        return found;
      },
      READ_ONLY,
    );
    if (row === undefined) throw batchNotFound();
    this.assertMay(row.kind);
    return toDetail(row);
  }

  /** The newest imports of the acting entity, for the kinds the caller may import. */
  async list(kind?: PartyImportKind): Promise<PartyImportBatch[]> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const kinds = (kind === undefined ? (['customer', 'vendor'] as const) : [kind]).filter((k) =>
      this.mayList(k),
    );
    if (kinds.length === 0) return [];
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const rows = await tx
          .select()
          .from(partyImportBatches)
          .where(scoped(scope).where(partyImportBatches, inArray(partyImportBatches.kind, kinds)))
          .orderBy(desc(partyImportBatches.createdAt), desc(partyImportBatches.id))
          .limit(50);
        return rows.map(toBatch);
      },
      READ_ONLY,
    );
  }

  // ---------------------------------------------------------------------------------------- duplicates

  /**
   * Lines that are still valid and whose key (PAN, else name) already belongs to a live record of the tenant become
   * `duplicate`. Tenant-wide whatever the caller may read, and ids are never returned: the line only says it exists.
   */
  private async markExisting(
    tx: DbTransaction,
    scope: TxScope,
    kind: PartyImportKind,
    rows: PartyImportRow[],
  ): Promise<PartyImportRow[]> {
    const keyed = rows.map((r) =>
      r.status === 'valid' && r.values !== undefined ? identityKey(kind, r.values) : null,
    );
    const panKeys = [
      ...new Set(
        keyed.filter((k): k is string => k?.startsWith('pan:') === true).map((k) => k.slice(4)),
      ),
    ];
    const nameKeys = [
      ...new Set(
        keyed.filter((k): k is string => k?.startsWith('name:') === true).map((k) => k.slice(5)),
      ),
    ];
    const existing = new Set<string>();
    if (kind === 'customer') {
      const panKey = sql<string>`regexp_replace(${customers.panVatNo}, '[[:space:]-]', '', 'g')`;
      if (panKeys.length > 0) {
        const found = await tx
          .select({ key: panKey })
          .from(customers)
          // Merged customers keep their PAN and the unique index still covers it, so they count here.
          .where(and(eq(customers.tenantId, scope.tenantId), inArray(panKey, panKeys)));
        for (const f of found) existing.add(`pan:${f.key}`);
      }
      if (nameKeys.length > 0) {
        const found = await tx
          .select({ key: customers.nameNorm })
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, scope.tenantId),
              isNull(customers.mergedIntoId),
              inArray(customers.nameNorm, nameKeys),
            ),
          );
        for (const f of found) existing.add(`name:${f.key}`);
      }
    } else {
      if (panKeys.length > 0) {
        const found = await tx
          .select({ pan: vendors.pan })
          .from(vendors)
          .where(and(eq(vendors.tenantId, scope.tenantId), inArray(vendors.pan, panKeys)));
        for (const f of found) if (f.pan !== null) existing.add(`pan:${f.pan}`);
      }
      if (nameKeys.length > 0) {
        const index = await this.vendorsService.nameIndex(tx, scope.tenantId);
        for (const key of nameKeys) if (index.has(key)) existing.add(`name:${key}`);
      }
    }
    return rows.map((r, i): PartyImportRow => {
      const key = keyed[i];
      if (key === null || key === undefined || !existing.has(key)) return r;
      const { values: _values, ...rest } = r;
      return { ...rest, status: 'duplicate', issues: [{ column: null, message: ALREADY_EXISTS }] };
    });
  }
}

// markVersionClean, the one place a quarantined version becomes clean (scan processor and generated files, D28).
// Unit level with a fake transaction: which columns it sets, what it audits, and that a version that is no
// longer quarantined writes nothing and audits nothing. The SQL guard itself runs against Postgres in
// scan.processor.test.ts and documents.generated.integration.test.ts.
import { randomUUID } from 'node:crypto';

import { documents, documentVersions } from '@bos/db';
import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../db/db.module';
import { GENERATED_ENGINE, markVersionClean } from './mark-version-clean';

const scope = { tenantId: randomUUID(), organizationId: randomUUID() };
const version = {
  id: randomUUID(),
  documentId: randomUUID(),
  version: 2,
  sha256: Buffer.alloc(32, 0xab),
};

/** A transaction whose version update returns `rows`, and that records every update (table and values). */
function fakeTx(rows: unknown[]) {
  const updates: { table: unknown; set: Record<string, unknown> }[] = [];
  const tx = {
    update: vi.fn((table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return {
          // The documents update is awaited as it is; the version update continues with returning().
          where: () => Object.assign(Promise.resolve(), { returning: () => Promise.resolve(rows) }),
        };
      },
    })),
  };
  return { tx: tx as unknown as DbTransaction, updates };
}

describe('markVersionClean', () => {
  it('sets the clean columns, repoints the document and audits the given result and engine', async () => {
    const row = { ...version, status: 'clean' };
    const { tx, updates } = fakeTx([row]);
    const audit = { record: vi.fn().mockResolvedValue(undefined) };

    const result = await markVersionClean(tx, audit, scope, version, {
      result: 'generated',
      engine: GENERATED_ENGINE,
    });

    expect(result).toBe(row);
    expect(updates.map((u) => u.table)).toEqual([documentVersions, documents]);
    expect(updates[0]?.set).toMatchObject({
      status: 'clean',
      scanSignature: null,
      scanEngine: 'generated',
    });
    expect(updates[0]?.set.scannedAt).toBeInstanceOf(Date);
    // The hash is kept as received, never touched here.
    expect(updates[0]?.set).not.toHaveProperty('sha256');
    expect(updates[1]?.set).toMatchObject({ currentVersionId: version.id });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(tx, {
      action: 'document.scanned',
      entityType: 'document_version',
      entityId: version.id,
      meta: { result: 'generated', engine: 'generated', sha256: 'ab'.repeat(32) },
    });
  });

  it('writes and audits nothing when the version is no longer quarantined', async () => {
    const { tx, updates } = fakeTx([]);
    const audit = { record: vi.fn() };

    const result = await markVersionClean(tx, audit, scope, version, {
      result: 'clean',
      engine: 'ClamAV test',
    });

    expect(result).toBeNull();
    expect(updates).toHaveLength(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits a null sha256 as null', async () => {
    const { tx } = fakeTx([{ ...version, status: 'clean' }]);
    const audit = { record: vi.fn().mockResolvedValue(undefined) };

    await markVersionClean(
      tx,
      audit,
      scope,
      { ...version, sha256: null },
      {
        result: 'clean',
        engine: 'clamd',
      },
    );

    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ meta: { result: 'clean', engine: 'clamd', sha256: null } }),
    );
  });
});

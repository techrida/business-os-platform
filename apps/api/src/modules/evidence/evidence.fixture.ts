// Test helper (integration suites only): uploads evidence the way the workspace does, through
// EvidenceDocumentsService (the per-kind routes), the real DocumentsService (upload grants, attach rule, type and
// size, quarantine) and the real `evidence` owner policy over the real tables. Only authz is the pure can() on the
// suite's own fake principal, and the scan queue is a stub, so an upload ends `quarantined`, as a real one does
// until the worker scans it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { Permission } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SignedLinks } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { EvidenceDocumentsService } from './evidence-documents.service';
import {
  drizzleEvidenceRecordLoader,
  EvidenceOwnerPolicy,
  type EvidenceRecordKind,
} from './evidence-owner.policy';

/** A small PDF the type check accepts. */
export const EVIDENCE_PDF = Buffer.from('%PDF-1.7\nevidence\n');

export interface EvidenceFixture {
  documents: DocumentsService;
  service: EvidenceDocumentsService;
  /** Creates and streams one evidence file on the record; returns its document id. */
  upload(kind: EvidenceRecordKind, recordId: string, bytes?: Buffer): Promise<string>;
  close(): Promise<void>;
}

/**
 * `who` is read on every call, so a suite that switches its caller (role, user, entity) uploads as that caller.
 * Registers nothing else: a suite that needs other owner types registers them on `documents`.
 */
export async function evidenceFixture(
  db: Db,
  who: () => { scope: TxScope; actor: Actor; principal: Principal },
): Promise<EvidenceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'bos-evidence-'));
  const authz = {
    assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
      const decision = can(who().principal, action, ref);
      if (!decision.allowed) {
        throw new ForbiddenException({ code: 'forbidden', reason: decision.reason });
      }
    },
  };
  const documents = new DocumentsService(
    db,
    new DiskStorageAdapter(root),
    new SignedLinks('evidence-fixture-signing-key-0000000000', {
      claim: () => Promise.resolve(true),
    }),
    { add: () => Promise.resolve({}) } as unknown as Queue,
    authz,
    new AuditService(db),
  );
  const load = drizzleEvidenceRecordLoader(db);
  documents.registerOwner(new EvidenceOwnerPolicy(load));
  const service = new EvidenceDocumentsService(db, load, { current: who }, documents);
  return {
    documents,
    service,
    async upload(kind, recordId, bytes = EVIDENCE_PDF) {
      const created = await service.create(kind, recordId, {
        filename: 'evidence.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: bytes.length,
      });
      await service.receive(
        kind,
        recordId,
        created.documentId,
        created.versionId,
        Readable.from(bytes),
        bytes.length,
      );
      return created.documentId;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

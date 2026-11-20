// TR-Q12e: assertNotInfected, the one rule every attach point calls. Unit level: the reader is faked and answers
// the versions the query would return; the newest version that was not rejected decides, as in allClean.
import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Db } from '../db/db.module';
import { assertNotInfected } from './documents.service';

const scope = { tenantId: randomUUID(), organizationId: randomUUID() };

type Row = { documentId: string; version: number; status: string; filename: string };

function readerOf(rows: Row[]): Pick<Db, 'select'> {
  const q = { from: () => q, where: () => Promise.resolve(rows) };
  return { select: () => q } as unknown as Pick<Db, 'select'>;
}

async function verdict(rows: Row[], ids: string[]): Promise<string> {
  try {
    await assertNotInfected(readerOf(rows), scope, ids);
    return 'ok';
  } catch (e) {
    if (e instanceof ConflictException) {
      const body = e.getResponse() as { code: string; message: string };
      return `${body.code}: ${body.message}`;
    }
    throw e;
  }
}

const d = randomUUID();
const v = (version: number, status: string, filename = `v${version}.pdf`): Row => ({
  documentId: d,
  version,
  status,
  filename,
});

describe('assertNotInfected', () => {
  it('refuses a document whose newest version is infected, naming that file', async () => {
    expect(await verdict([v(1, 'infected', 'eicar.pdf')], [d])).toBe(
      'document_infected: A virus was found in “eicar.pdf”. Remove it or upload a clean copy, then try again.',
    );
  });

  it('a rejected newer upload does not hide an infected one', async () => {
    expect(await verdict([v(1, 'infected'), v(2, 'rejected')], [d])).toMatch(/^document_infected/);
  });

  it('a newer version replaces an infected one, whatever its scan state', async () => {
    for (const status of ['clean', 'quarantined', 'awaiting_content', 'scan_failed']) {
      expect(await verdict([v(1, 'infected'), v(2, status)], [d])).toBe('ok');
    }
  });

  it('leaves files still scanning or failed to the submit rules (unchanged)', async () => {
    for (const status of ['awaiting_content', 'quarantined', 'scan_failed', 'clean']) {
      expect(await verdict([v(1, status)], [d])).toBe('ok');
    }
  });

  it('checks every id, and passes ids with no versions in scope to the caller’s own check', async () => {
    const other = randomUUID();
    expect(
      await verdict([v(1, 'clean'), { ...v(1, 'infected'), documentId: other }], [d, other]),
    ).toMatch(/^document_infected/);
    expect(await verdict([], [randomUUID()])).toBe('ok');
    expect(await verdict([], [])).toBe('ok');
    expect(await verdict([], ['not-a-uuid'])).toBe('ok');
  });
});

import 'server-only';

import { TermPresetSchema, type TermPreset, type TermPresetKind } from '@bos/contracts';
import { z } from 'zod';

import { call, seg } from './api-procurement';
import type { Session } from './session';

// Saved wording for quotation text fields. Reads are open to quotation.draft or admin.settings.write
// holders; the three writes need admin.settings.write (Founder). Every call carries the staff session.

const List = z.array(TermPresetSchema);

const json = (method: 'POST' | 'PATCH', body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** The saved list, by kind then name. Without `kind`, every kind. */
export function listTermPresets(session: Session, kind?: TermPresetKind): Promise<TermPreset[]> {
  const query = kind === undefined ? '' : `?kind=${encodeURIComponent(kind)}`;
  return call(session, `/v1/term-presets${query}`, List);
}

export function createTermPreset(
  session: Session,
  body: { kind: TermPresetKind; name: string; body: string; isDefault?: boolean },
): Promise<TermPreset> {
  return call(session, '/v1/admin/term-presets', TermPresetSchema, json('POST', body));
}

export function updateTermPreset(
  session: Session,
  id: string,
  body: { name?: string; body?: string; isDefault?: boolean },
): Promise<TermPreset> {
  return call(session, `/v1/admin/term-presets/${seg(id)}`, TermPresetSchema, json('PATCH', body));
}

/** 204: nothing comes back. */
export async function deleteTermPreset(session: Session, id: string): Promise<void> {
  await call(session, `/v1/admin/term-presets/${seg(id)}`, z.unknown(), { method: 'DELETE' });
}

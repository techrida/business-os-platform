import 'server-only';

import { createHash, createHmac, randomBytes } from 'node:crypto';

import { getEnv } from './env';
import {
  MemoDraftValuesSchema,
  type MemoDraftScopeId,
  type MemoDraftSnapshot,
  type MemoDraftValues,
} from './memo-working-draft-types';
import { getRedis, whenReady } from './session';
import { type Keyring, openSessionValue, sealSessionValue } from './session-crypto';

/**
 * The durable layer of the memo form's autosave: one working copy per account and scope (the new-memo form, or one
 * memo), kept in the session Valkey so it survives a refresh, a second tab and a logout. Valkey is append-only
 * persisted, so the content is sealed with AES-256-GCM (session-crypto, the session key ring) before it is stored.
 * No database migration: this is a working copy, not the memo. Saving the memo itself still goes through the API.
 *
 * Identity. The key is derived on the server from the authenticated session (org id and `sub`) plus the scope, never
 * from anything the caller sends, and is hashed so a key listing reveals neither. The caller's right to touch a scope
 * is checked by memo-working-draft-access.ts before any call here.
 *
 *   ws:memo-draft:<sha256(orgId \0 sub \0 scope), hex>      a Valkey hash, fields:
 *     rev   opaque 12-character revision, new on every write
 *     del   '1' for a tombstone, '0' for a live draft
 *     at    ISO time of the last change (not sensitive)
 *     data  sealed JSON of the values (empty for a tombstone); the AAD is `<key>|<rev>`, so a sealed value
 *           copied to another key or another revision does not open
 *
 * Concurrency. Every write is a compare-and-set on `rev` in one Lua script: it applies only when the stored revision
 * is the one the writer last saw, so two tabs can never silently overwrite each other (the loser gets the current
 * snapshot back). Deleting writes a tombstone with its own revision instead of removing the key, so a tab that still
 * holds the old revision cannot write the draft back to life: its write is a conflict, not a resurrection.
 */

/** A live draft idles out after this long without a write; every write slides it. */
export const DRAFT_TTL_SECONDS = 30 * 86400;
/** A tombstone only has to outlive the stalest tab that could still write; a week is far past that. */
export const TOMBSTONE_TTL_SECONDS = 7 * 86400;

const KEY_PREFIX = 'ws:memo-draft:';
const NEW_SCOPE = 'new';

export interface DraftOwner {
  orgId: string;
  sub: string;
}

/** Binds an open editor to the account that rendered it, even if another tab replaces its cookie. */
export function memoDraftAccount(owner: DraftOwner): string {
  return createHmac('sha256', Buffer.from(getEnv().SESSION_ENC_KEY, 'base64'))
    .update(JSON.stringify(['memo-working-draft', owner.orgId, owner.sub]))
    .digest('base64url');
}

/** A Valkey failure. The caller answers 503 and nothing else: the draft is never served or written blind. */
export class DraftStoreUnavailableError extends Error {
  constructor() {
    super('The draft store is unavailable');
    this.name = 'DraftStoreUnavailableError';
  }
}

export type WriteOutcome =
  { ok: true; snapshot: MemoDraftSnapshot } | { ok: false; current: MemoDraftSnapshot };

/** Compare-and-set: apply only when the stored revision equals ARGV[1] ('' for "nothing stored"). */
const WRITE_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'rev')
if cur == false then cur = '' end
if cur ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'rev', ARGV[2], 'del', ARGV[3], 'at', ARGV[4], 'data', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 1
`;

/** Scope key: the memo id lower-cased (it is validated as a UUID upstream) or `new`. */
export function draftKey(owner: DraftOwner, scopeId: MemoDraftScopeId): string {
  const scope = scopeId === null ? NEW_SCOPE : scopeId.toLowerCase();
  const digest = createHash('sha256')
    .update(`${owner.orgId}\0${owner.sub}\0${scope}`)
    .digest('hex');
  return `${KEY_PREFIX}${digest}`;
}

function keyring(): Keyring {
  const env = getEnv();
  return {
    currentId: env.SESSION_ENC_KEY_ID,
    keys: new Map([[env.SESSION_ENC_KEY_ID, Buffer.from(env.SESSION_ENC_KEY, 'base64')]]),
  };
}

const aadOf = (key: string, revision: string) => `${key}|${revision}`;
const newRevision = () => randomBytes(9).toString('base64url');
const EMPTY: MemoDraftSnapshot = { revision: null, values: null, updatedAt: null };

/** Only the error name is logged: ioredis errors carry the command arguments, here the sealed content. */
function unavailable(err: unknown): DraftStoreUnavailableError {
  console.warn(
    JSON.stringify({
      event: 'memo_draft.valkey_unavailable',
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  return new DraftStoreUnavailableError();
}

async function client() {
  return whenReady(getRedis());
}

/** The current snapshot of a scope. A record that does not open is served as deleted, so the next write heals it. */
export async function readDraft(
  owner: DraftOwner,
  scopeId: MemoDraftScopeId,
): Promise<MemoDraftSnapshot> {
  const key = draftKey(owner, scopeId);
  let fields: (string | null)[];
  try {
    fields = await (await client()).hmget(key, 'rev', 'del', 'at', 'data');
  } catch (err) {
    throw unavailable(err);
  }
  return snapshotOf(key, fields);
}

function snapshotOf(key: string, fields: (string | null)[]): MemoDraftSnapshot {
  const [revision, deleted, at, data] = fields;
  if (revision === null || revision === undefined) return EMPTY;
  const updatedAt = at ?? null;
  if (deleted === '1' || data === null || data === undefined || data === '') {
    return { revision, values: null, updatedAt };
  }
  const plaintext = openSessionValue(data, aadOf(key, revision), keyring());
  let values: MemoDraftValues | null = null;
  if (plaintext !== null) {
    try {
      const parsed = MemoDraftValuesSchema.safeParse(JSON.parse(plaintext));
      if (parsed.success) values = parsed.data;
    } catch {
      values = null;
    }
  }
  if (values === null) console.warn(JSON.stringify({ event: 'memo_draft.decrypt_failed' }));
  return { revision, values, updatedAt };
}

async function write(
  owner: DraftOwner,
  scopeId: MemoDraftScopeId,
  expected: string | null,
  deleted: boolean,
  values: MemoDraftValues | null,
): Promise<WriteOutcome> {
  const key = draftKey(owner, scopeId);
  const revision = newRevision();
  const at = new Date().toISOString();
  // Copy field by field through the schema: never persist a stray property a caller happened to pass in.
  const clean = values === null ? null : MemoDraftValuesSchema.parse(values);
  const data =
    clean === null ? '' : sealSessionValue(JSON.stringify(clean), aadOf(key, revision), keyring());
  try {
    const redis = await client();
    const applied = await redis.eval(
      WRITE_SCRIPT,
      1,
      key,
      expected ?? '',
      revision,
      deleted ? '1' : '0',
      at,
      data,
      String(deleted ? TOMBSTONE_TTL_SECONDS : DRAFT_TTL_SECONDS),
    );
    if (Number(applied) === 1) {
      return { ok: true, snapshot: { revision, values: clean, updatedAt: at } };
    }
    // Lost the race. One HMGET returns a consistent revision and content pair.
    const fields = await redis.hmget(key, 'rev', 'del', 'at', 'data');
    return { ok: false, current: snapshotOf(key, fields) };
  } catch (err) {
    throw unavailable(err);
  }
}

/** Saves `values` if the stored revision is `expected` (null: nothing stored). */
export function writeDraft(
  owner: DraftOwner,
  scopeId: MemoDraftScopeId,
  expected: string | null,
  values: MemoDraftValues,
): Promise<WriteOutcome> {
  return write(owner, scopeId, expected, false, values);
}

/** Deletes by writing a tombstone if the stored revision is `expected`. The snapshot has the tombstone's revision. */
export function tombstoneDraft(
  owner: DraftOwner,
  scopeId: MemoDraftScopeId,
  expected: string | null,
): Promise<WriteOutcome> {
  return write(owner, scopeId, expected, true, null);
}

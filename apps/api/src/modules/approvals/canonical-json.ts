// Canonical JSON for the approval snapshot hash: sorted keys, no whitespace, numbers as JSON prints
// them. Serves the NFR "approvals are auditable": the same document always hashes to the same
// snapshot_sha256, whatever order its keys were built in, so a stored hash can be re-checked later.
import { createHash } from 'node:crypto';

/**
 * Serialises `value` the way JSON.stringify would, except that object keys are sorted (by UTF-16
 * code unit, like Array.prototype.sort) at every depth. `undefined` object members are dropped and
 * `undefined` array items become null, as in JSON. Non-finite numbers and bigints throw: they have no
 * JSON form, and silently writing `null` would let two different snapshots share one hash.
 */
export function canonicalJson(value: unknown): string {
  const out = write(value);
  if (out === undefined) throw new TypeError('canonicalJson: the top-level value has no JSON form');
  return out;
}

/** sha256(canonicalJson(value)) as raw bytes (the bytea that approval_requests stores). */
export function canonicalSha256(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

function write(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} has no JSON form`);
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint has no JSON form; pass it as a string');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  // Dates and other objects with toJSON (as JSON.stringify does) are written as what toJSON returns.
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return write(withToJson.toJSON());
  if (Array.isArray(value)) return `[${value.map((item) => write(item) ?? 'null').join(',')}]`;
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const member = write(record[key]);
    if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
  }
  return `{${members.join(',')}}`;
}

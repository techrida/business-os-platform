// Pure, DOM-free helpers for the dev menu widget. Kept separate so they run under plain node.

export type DevMenuState = { open: boolean; hidden: boolean };

export type WhoamiView =
  | { kind: 'ok'; rows: Array<[label: string, value: string]> }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string };

const ORG_KINDS = ['staff', 'customer', 'vendor'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads persisted state. Tolerates null, invalid JSON and wrong types: those fall back to false. */
export function parseState(raw: string | null): DevMenuState {
  if (raw === null) return { open: false, hidden: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { open: false, hidden: false };
    return { open: parsed['open'] === true, hidden: parsed['hidden'] === true };
  } catch {
    return { open: false, hidden: false };
  }
}

export function serializeState(state: DevMenuState): string {
  return JSON.stringify({ open: state.open, hidden: state.hidden });
}

/**
 * Turns a /dev/api/whoami JSON body into display rows. Validates the shape defensively and
 * copies only the known fields, so unexpected keys in the response never reach the DOM.
 * A `{ error }` body is the signed-out answer (HTTP 401); callers pass the body only for 200
 * and 401, and report other statuses themselves.
 */
export function formatWhoami(json: unknown): WhoamiView {
  if (!isRecord(json)) return { kind: 'error', message: 'Unexpected response' };

  if (typeof json['error'] === 'string' && !('userId' in json)) return { kind: 'signed-out' };

  const { userId, tenantId, organizationId, correlationId, orgKind, roles } = json;
  if (
    typeof userId !== 'string' ||
    typeof tenantId !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof correlationId !== 'string' ||
    typeof orgKind !== 'string' ||
    !(ORG_KINDS as readonly string[]).includes(orgKind) ||
    !Array.isArray(roles) ||
    !roles.every((role): role is string => typeof role === 'string')
  ) {
    return { kind: 'error', message: 'Unexpected response' };
  }

  return {
    kind: 'ok',
    rows: [
      ['User', userId],
      ['Tenant', tenantId],
      ['Organisation', organizationId],
      ['Org kind', orgKind],
      ['Roles', roles.length > 0 ? roles.join(', ') : 'none'],
      ['Correlation ID', correlationId],
    ],
  };
}

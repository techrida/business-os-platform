import { describe, expect, it } from 'vitest';

import { formatWhoami, parseState, serializeState } from './dev-menu-state';

const valid = {
  userId: 'u-1',
  tenantId: 't-1',
  organizationId: 'o-1',
  correlationId: 'c-1',
  orgKind: 'staff',
  roles: ['admin', 'viewer'],
};

describe('parseState', () => {
  it('defaults to closed and visible', () => {
    expect(parseState(null)).toEqual({ open: false, hidden: false });
  });

  it.each(['', 'not json', '{', 'null', '[]', '42', '"x"', '{"open":"yes","hidden":1}'])(
    'tolerates garbage %j',
    (raw) => {
      expect(parseState(raw)).toEqual({ open: false, hidden: false });
    },
  );

  it('reads known booleans and ignores other keys', () => {
    expect(parseState('{"open":true,"hidden":true,"extra":1}')).toEqual({
      open: true,
      hidden: true,
    });
    expect(parseState('{"open":true}')).toEqual({ open: true, hidden: false });
  });

  it('round-trips through serializeState', () => {
    const state = { open: true, hidden: false };
    expect(parseState(serializeState(state))).toEqual(state);
    expect(serializeState({ open: false, hidden: true })).toBe('{"open":false,"hidden":true}');
  });
});

describe('formatWhoami', () => {
  it('formats a valid body as labelled rows with roles joined', () => {
    expect(formatWhoami(valid)).toEqual({
      kind: 'ok',
      rows: [
        ['User', 'u-1'],
        ['Tenant', 't-1'],
        ['Organisation', 'o-1'],
        ['Org kind', 'staff'],
        ['Roles', 'admin, viewer'],
        ['Correlation ID', 'c-1'],
      ],
    });
  });

  it('shows "none" for an empty role list', () => {
    const view = formatWhoami({ ...valid, roles: [] });
    expect(view.kind === 'ok' && view.rows[4]).toEqual(['Roles', 'none']);
  });

  it('does not leak unknown keys', () => {
    const view = formatWhoami({ ...valid, secret: 'hunter2', accessToken: 'abc' });
    expect(JSON.stringify(view)).not.toContain('hunter2');
    expect(JSON.stringify(view)).not.toContain('abc');
    expect(view.kind === 'ok' && view.rows).toHaveLength(6);
  });

  it('reports signed-out for an error body', () => {
    expect(formatWhoami({ error: 'unauthenticated' })).toEqual({ kind: 'signed-out' });
  });

  it.each([null, undefined, 'text', 42, [], [valid], {}])('rejects non-object or empty %j', (v) => {
    expect(formatWhoami(v).kind).toBe('error');
  });

  it.each(['userId', 'tenantId', 'organizationId', 'correlationId', 'orgKind', 'roles'])(
    'rejects a body missing %s',
    (key) => {
      const body: Record<string, unknown> = { ...valid };
      delete body[key];
      expect(formatWhoami(body).kind).toBe('error');
    },
  );

  it('rejects wrong types and unknown org kinds', () => {
    expect(formatWhoami({ ...valid, userId: 7 }).kind).toBe('error');
    expect(formatWhoami({ ...valid, roles: 'admin' }).kind).toBe('error');
    expect(formatWhoami({ ...valid, roles: ['admin', 3] }).kind).toBe('error');
    expect(formatWhoami({ ...valid, orgKind: 'alien' }).kind).toBe('error');
    expect(formatWhoami({ ...valid, orgKind: 1 }).kind).toBe('error');
  });

  it('does not treat a full body with an error key as signed-out', () => {
    expect(formatWhoami({ ...valid, error: 'x' }).kind).toBe('ok');
  });
});

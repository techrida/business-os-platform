// Tests for the kernel seed rows. A fake pg client records every statement and answers from a small
// script, so we can check the order (BEGIN, seed actor, rows, COMMIT) and idempotency without Postgres.
import { DEFAULT_ROLE_PERMISSIONS, WorkflowSpecSchema } from '@bos/contracts';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { TEST_MEMO_WORKFLOW_SPEC, seedKernelRows, setSeedActor } from './db-seed.js';
import { PgTenancyStore } from './index.js';

const scope = { tenantId: 'tenant-1', organizationId: 'org-1', correlationId: 'corr-1' };

interface Call {
  text: string;
  values: unknown[];
}
type Reply = { rowCount?: number; rows?: unknown[] };
type Script = (call: Call) => Reply | undefined;

function fakeClient(script: Script = () => undefined) {
  const calls: Call[] = [];
  const client = {
    query: (text: string, values: unknown[] = []) => {
      const call = { text: text.replace(/\s+/g, ' ').trim(), values };
      calls.push(call);
      const reply = script(call);
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ rowCount: reply?.rowCount ?? 0, rows: reply?.rows ?? [] });
    },
  };
  return { client: client as unknown as pg.ClientBase, calls };
}

/** First run: every insert changes one row and the version insert returns its id. */
const firstRun: Script = ({ text }) => {
  if (text.startsWith('SELECT id FROM app.workflow_definitions'))
    return { rows: [{ id: 'def-1' }] };
  if (text.includes('INTO app.workflow_versions')) return { rowCount: 1, rows: [{ id: 'ver-1' }] };
  if (text.startsWith('INSERT') || text.startsWith('UPDATE')) return { rowCount: 1 };
  return undefined;
};

/** Second run: ON CONFLICT ... DO NOTHING / unchanged WHERE clauses return no rows. */
const nothingChanged: Script = ({ text }) => {
  if (text.startsWith('SELECT id FROM app.workflow_definitions'))
    return { rows: [{ id: 'def-1' }] };
  return undefined;
};

const grantCount = Object.values(DEFAULT_ROLE_PERMISSIONS).reduce(
  (sum, grants) => sum + Object.keys(grants).length,
  0,
);

describe('setSeedActor', () => {
  it('sets the seed actor in one local set_config statement', async () => {
    const { client, calls } = fakeClient();
    await setSeedActor(client, scope);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.text).toMatch(/^SELECT set_config\('bos\.tenant_id', \$1, true\)/);
    for (const name of [
      'tenant_id',
      'organization_id',
      'actor_kind',
      'actor_id',
      'correlation_id',
      'ip',
      'user_agent',
    ]) {
      expect(call?.text).toContain(`set_config('bos.${name}'`);
    }
    expect(call?.text).not.toContain('false)');
    expect(call?.values).toEqual(['tenant-1', 'org-1', 'seed', 'seed', 'corr-1', '', '']);
  });
});

describe('seedKernelRows', () => {
  it('runs BEGIN, the seed actor, the rows, then COMMIT', async () => {
    const { client, calls } = fakeClient(firstRun);
    const changed = await seedKernelRows(client, scope);

    expect(calls[0]?.text).toBe('BEGIN');
    expect(calls[1]?.text).toContain("set_config('bos.actor_id'");
    expect(calls[1]?.values).toContain('seed');
    expect(calls.at(-1)?.text).toBe('COMMIT');
    expect(calls.filter((c) => c.text === 'BEGIN')).toHaveLength(1);
    expect(calls.some((c) => c.text === 'ROLLBACK')).toBe(false);

    const index = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(index('INTO app.role_permissions')).toBeGreaterThan(1);
    expect(index('INTO app.authz_versions')).toBeGreaterThan(index('INTO app.role_permissions'));
    expect(index('INTO app.workflow_definitions')).toBeGreaterThan(
      index('INTO app.authz_versions'),
    );
    expect(index('INTO app.fx_rates')).toBeGreaterThan(index('INTO app.workflow_versions'));
    // grants + authz bump + definition + version + current_version_id + fx peg
    expect(changed).toBe(grantCount + 1 + 1 + 1 + 1 + 1);
  });

  it('rolls back and rethrows when a statement fails', async () => {
    const boom = new Error('trigger raised');
    const { client, calls } = fakeClient(({ text }) => {
      if (text.includes('INTO app.fx_rates')) return boom as unknown as Reply;
      return firstRun({ text, values: [] });
    });
    await expect(seedKernelRows(client, scope)).rejects.toThrow('trigger raised');
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
    expect(calls.some((c) => c.text === 'COMMIT')).toBe(false);
  });

  it('writes one role_permissions row for every default grant', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const rows = calls
      .filter((c) => c.text.includes('INTO app.role_permissions'))
      .map((c) => c.values);
    expect(rows).toHaveLength(grantCount);
    for (const values of rows) expect(values.slice(0, 2)).toEqual(['tenant-1', 'org-1']);

    const written = new Set(rows.map((v) => `${String(v[2])}|${String(v[3])}|${String(v[4])}`));
    for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const [permission, grantScope] of Object.entries(grants)) {
        expect(written.has(`${role}|${permission}|${grantScope}`)).toBe(true);
      }
    }
    const sql = calls.find((c) => c.text.includes('INTO app.role_permissions'))?.text;
    expect(sql).toContain('ON CONFLICT (tenant_id, organization_id, role_key, permission)');
    expect(sql).toContain('IS DISTINCT FROM');
  });

  it('inserts workflow test_memo v1 as published with a valid spec and sets current_version_id', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const definition = calls.find((c) => c.text.includes('INTO app.workflow_definitions'));
    expect(definition?.text).toContain("'test_memo', 'Test memo approval', 'test_memo'");

    const version = calls.find((c) => c.text.includes('INTO app.workflow_versions'));
    expect(version?.text).toContain("1, 'published', $4::jsonb, now(), NULL");
    expect(version?.text).toContain('ON CONFLICT (definition_id, version) DO NOTHING');
    expect(version?.values.slice(0, 3)).toEqual(['tenant-1', 'org-1', 'def-1']);

    const stored = JSON.parse(String(version?.values[3])) as unknown;
    expect(WorkflowSpecSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({
      documentType: 'test_memo',
      distinctApprovers: true,
      sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
    });
    const spec = WorkflowSpecSchema.parse(stored);
    expect(spec.steps.map((s) => s.role)).toEqual(['accountant', 'finance']);
    expect(spec.rules.map((r) => [r.id, r.add.role])).toEqual([
      ['mgmt-over-1-lakh', 'management'],
      ['founder-over-10-lakh', 'founder'],
    ]);

    const update = calls.find((c) => c.text.startsWith('UPDATE app.workflow_definitions'));
    expect(update?.values).toEqual(['ver-1', 'def-1']);
  });

  it('keeps TEST_MEMO_WORKFLOW_SPEC valid', () => {
    expect(WorkflowSpecSchema.safeParse(TEST_MEMO_WORKFLOW_SPEC).success).toBe(true);
  });

  it('seeds the INR peg at 1.6 from the earliest date', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const fx = calls.find((c) => c.text.includes('INTO app.fx_rates'));
    expect(fx?.text).toContain("'INR'");
    expect(fx?.text).toContain("'NRB peg'");
    expect(fx?.text).toContain('ON CONFLICT DO NOTHING');
    expect(fx?.values).toEqual(['tenant-1', 'org-1', '1.6', '2000-01-01']);
  });

  it('returns 0 and does not bump authz_versions or touch v1 when nothing changed', async () => {
    const { client, calls } = fakeClient(nothingChanged);
    const changed = await seedKernelRows(client, scope);

    expect(changed).toBe(0);
    expect(calls.some((c) => c.text.includes('INTO app.authz_versions'))).toBe(false);
    expect(calls.some((c) => c.text.startsWith('UPDATE'))).toBe(false);
    expect(calls[0]?.text).toBe('BEGIN');
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });
});

describe('seedKernelRows: stale role grants (R25)', () => {
  /** First run against a table that still holds one grant the defaults no longer list. */
  const staleRow: Script = (call) =>
    call.text.startsWith('DELETE FROM app.role_permissions')
      ? { rowCount: 1, rows: [{ id: 'stale-1' }] }
      : nothingChanged(call);

  it('deletes role_permissions rows the defaults no longer list, then bumps authz_versions', async () => {
    const { client, calls } = fakeClient(staleRow);
    const changed = await seedKernelRows(client, scope);

    const del = calls.filter((c) => c.text.startsWith('DELETE FROM app.role_permissions'));
    expect(del).toHaveLength(1);
    expect(del[0]?.values.slice(0, 2)).toEqual(['tenant-1', 'org-1']);
    // The keep-list holds every default (role, permission) pair, in two parallel arrays.
    const [roles, permissions] = [del[0]?.values[2], del[0]?.values[3]] as [string[], string[]];
    const kept = new Set(roles.map((role, i) => `${role}|${String(permissions[i])}`));
    expect(kept.size).toBe(grantCount);
    for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const permission of Object.keys(grants)) {
        expect(kept.has(`${role}|${permission}`)).toBe(true);
      }
    }

    const index = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(index('DELETE FROM app.role_permissions')).toBeGreaterThan(
      index('INTO app.role_permissions'),
    );
    expect(index('INTO app.authz_versions')).toBeGreaterThan(
      index('DELETE FROM app.role_permissions'),
    );
    // Only the deleted row counts: this fake answers the authz bump with rowCount 0.
    expect(changed).toBe(1);
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('deletes nothing and bumps nothing on a second run', async () => {
    const { client, calls } = fakeClient(nothingChanged);
    expect(await seedKernelRows(client, scope)).toBe(0);
    expect(calls.filter((c) => c.text.startsWith('DELETE'))).toHaveLength(1);
    expect(calls.some((c) => c.text.includes('INTO app.authz_versions'))).toBe(false);
  });
});

describe('PgTenancyStore (R5)', () => {
  /** A store over one fake client; counts how often the connection is closed. */
  function storeOver(script: Script) {
    const fake = fakeClient(script);
    let closed = 0;
    const store = new PgTenancyStore(() =>
      Promise.resolve({
        client: fake.client,
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
    );
    return { store, calls: fake.calls, closed: () => closed };
  }
  const rows = [
    { zitadelOrgId: 'z-staff', kind: 'staff' as const, name: 'Techrida Staff' },
    { zitadelOrgId: 'z-cust', kind: 'customer' as const, name: 'Dev Customer Co' },
  ];

  it('sets the seed actor right after BEGIN, before any app.* write, on a fresh database', async () => {
    const { store, calls, closed } = storeOver(({ text }) =>
      text.startsWith('INSERT') ? { rowCount: 1 } : undefined,
    );
    const changed = await store.upsertOrganizations(rows, 'corr-9');

    expect(calls[0]?.text).toBe('BEGIN');
    expect(calls[1]?.text).toMatch(/^SELECT set_config\('bos\.tenant_id'/);
    expect(calls[1]?.values).toEqual(['', '', 'seed', 'seed', 'corr-9', '', '']);
    const firstWrite = calls.findIndex((c) => /^(INSERT|UPDATE|DELETE)/.test(c.text));
    expect(firstWrite).toBeGreaterThan(1);
    expect(calls[firstWrite]?.text).toContain('INTO app.tenants');
    expect(calls.at(-1)?.text).toBe('COMMIT');
    expect(changed).toBe(1 + rows.length);
    expect(closed()).toBe(1);
  });

  it('reports 0 when the tenant and every row already exist', async () => {
    const { store, calls } = storeOver(({ text }) =>
      text.startsWith('SELECT tenant_id') ? { rows: [{ tenant_id: 't-1' }] } : undefined,
    );
    expect(await store.upsertOrganizations(rows, 'corr-9')).toBe(0);
    expect(calls.some((c) => c.text.includes('INTO app.tenants'))).toBe(false);
  });

  it('seeds kernel rows for the staff org by our uuid; a second run returns 0', async () => {
    const lookup = (call: Call): Reply | undefined =>
      call.text.startsWith('SELECT id, tenant_id FROM app.organizations')
        ? { rows: [{ id: 'org-uuid', tenant_id: 'tenant-uuid' }] }
        : undefined;
    const first = storeOver((call) => lookup(call) ?? firstRun(call));
    expect(await first.store.seedKernel('z-staff', 'corr-9')).toBeGreaterThan(0);
    expect(first.calls[0]?.values).toEqual(['z-staff']);
    const grant = first.calls.find((c) => c.text.includes('INTO app.role_permissions'));
    expect(grant?.values.slice(0, 2)).toEqual(['tenant-uuid', 'org-uuid']);
    expect(first.closed()).toBe(1);

    const second = storeOver((call) => lookup(call) ?? nothingChanged(call));
    expect(await second.store.seedKernel('z-staff', 'corr-9')).toBe(0);
  });

  it('fails clearly when the staff org has no row yet', async () => {
    const { store, closed } = storeOver(() => undefined);
    await expect(store.seedKernel('z-staff', 'corr-9')).rejects.toThrow(/no row for staff org/);
    expect(closed()).toBe(1);
  });
});

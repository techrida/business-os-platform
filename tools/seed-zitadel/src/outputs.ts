// Everything the seed writes to `.dev/`, plus the token inspection used for risk R7.
import { chmod, chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

export interface DevFiles {
  read(name: string): Promise<string | undefined>;
  /** Writes only when the content differs. Returns whether the file changed. */
  write(name: string, content: string): Promise<boolean>;
}

/**
 * The `.dev` directory as seen by the seed container.
 *
 * Two traps this class handles:
 *  1. `writeFile(..., {mode})` only applies the mode when it CREATES the file, so we chmod after
 *     every write.
 *  2. The container runs as root (it must read root-owned admin.pat), so new files would be
 *     root-owned 0600 and the host user could neither read `k6.env` (docker compose reads
 *     `env_file` on the host) nor `personas.json` (next dev). We chown to the owner of the
 *     directory itself. chown failing (not root, Windows) is fine: then we already own the file.
 */
export class DevDir implements DevFiles {
  constructor(private readonly dir: string) {}

  async read(name: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.dir, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(name: string, content: string): Promise<boolean> {
    if ((await this.read(name)) === content) {
      await this.fixPermissions(join(this.dir, name));
      return false;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, name);
    await writeFile(path, content, { mode: 0o600 });
    await this.fixPermissions(path);
    return true;
  }

  private async fixPermissions(path: string): Promise<void> {
    await chmod(path, 0o600);
    try {
      const dir = await stat(this.dir);
      await chown(path, dir.uid, dir.gid);
    } catch {
      // Not allowed or not supported: the file already belongs to whoever runs the seed.
    }
  }
}

/** `KEY=value` lines, sorted by insertion order. Values here never contain spaces or quotes. */
export function renderEnv(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
}

export function parseEnv(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (text === undefined) return out;
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) out[match[1] as string] = match[2] as string;
  }
  return out;
}

/**
 * Scope string for the load-test token. Keep in sync with `perf/k6/load.js`:
 *  - `...:project:id:{id}:aud` puts the project id into `aud` (the API checks it);
 *  - `...:projects:roles` asks for the role claim;
 *  - `...:resourceowner` asks for the org claims the tenancy resolver needs.
 */
export const loadtestScope = (projectId: string): string =>
  [
    'openid',
    `urn:zitadel:iam:org:project:id:${projectId}:aud`,
    'urn:zitadel:iam:org:projects:roles',
    'urn:zitadel:iam:user:resourceowner',
  ].join(' ');

const base64UrlToString = (part: string): string => Buffer.from(part, 'base64url').toString('utf8');

const ClaimsSchema = z.record(z.string(), z.unknown());

/** Decodes the payload of a JWT WITHOUT verifying it. For inspection only, never for trust. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(
      `Access token is not a JWT (${parts.length} dot-separated parts, expected 3). ` +
        'The machine user or app is probably issuing opaque tokens.',
    );
  }
  return ClaimsSchema.parse(JSON.parse(base64UrlToString(parts[1] as string)));
}

export interface TokenReport {
  claimKeys: string[];
  audienceHasProject: boolean;
  hasRoleClaim: boolean;
  hasResourceOwnerClaim: boolean;
  /** The token's client: `azp`, else `client_id`. The same rule as the API's jwt-verifier. */
  clientId?: string;
}

export function inspectToken(token: string, projectId: string): TokenReport {
  const claims = decodeJwtClaims(token);
  const aud = claims['aud'];
  const audiences: unknown[] =
    typeof aud === 'string' ? [aud] : Array.isArray(aud) ? (aud as unknown[]) : [];
  const claimKeys = Object.keys(claims).sort();
  const client = claims['azp'] ?? claims['client_id'];
  return {
    claimKeys,
    ...(typeof client === 'string' ? { clientId: client } : {}),
    audienceHasProject: audiences.includes(projectId),
    hasRoleClaim: claimKeys.some(
      (k) => k.startsWith('urn:zitadel:iam:org:project:') && k.endsWith(':roles'),
    ),
    hasResourceOwnerClaim: claimKeys.some((k) =>
      k.startsWith('urn:zitadel:iam:user:resourceowner'),
    ),
  };
}

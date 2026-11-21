import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// withTx takes the tenant's audit-chain lock before its callback runs (tx.ts). Network I/O inside the callback holds
// that lock, and with it every write of the tenant, for the length of the call; a nested withTx opens a second
// connection that waits for the lock its own outer transaction holds. So a withTx callback in apps/api/src must not
// call fetch, axios, http(s).request, a ZITADEL client or another withTx. If this fails, make the call before or
// after the transaction, as the user sync does (user-mirror.ts reads ZITADEL with no transaction open).
//
// Only calls written in the callback itself are seen; I/O reached through another service's method is not. The
// structural rule below covers the known indirect case: a transaction wrapped in zitadelCall() calls ZITADEL
// through a service, so it must be one of ALLOWED and must pass `audit: 'lazy'`.

const SELF = resolve(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Transactions that call ZITADEL inside withTx (through UserStatusService / UsersService) and therefore take the
 * tenant audit lock lazily (CALLS_ZITADEL in admin-users.controller.ts). Do not add to this list: move the call out
 * of the transaction instead.
 */
const ALLOWED: readonly { file: string; fn: string }[] = [
  { file: 'platform/users/admin-users.controller.ts', fn: 'runStatusAction' },
  { file: 'platform/users/admin-users.controller.ts', fn: 'invite' },
  { file: 'platform/users/admin-users.controller.ts', fn: 'setRoles' },
];

const NETWORK =
  /\bfetch\s*\(|\baxios\b|\bhttps?\s*\.\s*(?:request|get)\s*\(|\b(?:zitadel|Zitadel)(?:Client|Admin|AdminClient|Api)?\s*\.\s*\w+\s*\(|\.\s*(?:getUser|listUsers|listGrants|createHuman|setGrants|sendInviteCode|sendPasswordReset|deactivateUser|reactivateUser|deleteUser|lockUser|unlockUser|ensureOrgLockoutPolicy|ensureOrgLoginPolicy)\s*\(|\bwithTx\s*\(/g;

function isTest(name: string): boolean {
  return /\.(test|spec)\.ts$/.test(name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !isTest(name))
    .map((name) => resolve(join(dir, name)))
    .filter((file) => file !== SELF);
}

/**
 * The source with comments, string text and template text (not the `${}` code in it) replaced by spaces, offsets and
 * line breaks kept. A `/` after an operator or an opening bracket starts a regex literal, masked too.
 */
function mask(src: string): string {
  const out = src.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  const templates: number[] = []; // brace depth at which each open `${` returns to its template
  let depth = 0;
  let i = 0;
  const inTemplate = (): void => {
    // At the char after '`' or after the '}' that closed a `${`.
    while (i < src.length) {
      if (src[i] === '\\') {
        blank(i);
        blank(i + 1);
        i += 2;
      } else if (src[i] === '`') {
        i += 1;
        return;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        templates.push(depth);
        depth += 1;
        i += 2;
        return;
      } else {
        blank(i);
        i += 1;
      }
    }
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) blank(i++);
    } else if (c === "'" || c === '"') {
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') blank(i++);
        blank(i++);
      }
      i += 1;
    } else if (c === '`') {
      i += 1;
      inTemplate();
    } else if (
      c === '/' &&
      /[(,=:[!&|?{};+\-*%<>~^]\s*$|^\s*$|\breturn\s*$/.test(
        src
          .slice(Math.max(0, i - 12), i)
          .split('\n')
          .at(-1) ?? '',
      )
    ) {
      i += 1;
      let inClass = false;
      while (i < src.length && src[i] !== '\n' && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') blank(i++);
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        blank(i++);
      }
      i += 1;
    } else if (c === '{') {
      depth += 1;
      i += 1;
    } else if (c === '}') {
      depth -= 1;
      i += 1;
      if (templates.at(-1) === depth) {
        templates.pop();
        inTemplate();
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** Index of the `)` that closes the `(` at `open` in masked text, or -1. */
function closeOf(masked: string, open: number): number {
  let level = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') level += 1;
    else if (masked[i] === ')') {
      level -= 1;
      if (level === 0) return i;
    }
  }
  return -1;
}

/** The method or function a call sits in: the nearest class member (two-space indent) or function above it. */
function enclosingFunction(masked: string, at: number): string {
  const before = masked.slice(0, at);
  const header =
    /^(?: {2}(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*(?:<[^>\n]*>)?\(|(?:export\s+)?(?:async\s+)?function\s+(\w+))/gm;
  let name = '<top level>';
  for (const m of before.matchAll(header)) name = m[1] ?? m[2] ?? name;
  return name;
}

interface TxCall {
  line: number;
  fn: string;
  /** -1 when the call never closes: the masking went wrong and the scan cannot be trusted. */
  end: number;
  hits: string[];
  insideZitadelCall: boolean;
  lazy: boolean;
}

/** Top-level arguments of the call whose `(` is at `open`, as source text. */
function argsOf(src: string, masked: string, open: number, end: number): string[] {
  const args: string[] = [];
  let level = 0;
  let from = open + 1;
  for (let i = open + 1; i < end; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') level += 1;
    else if (c === ')' || c === '}' || c === ']') level -= 1;
    else if (c === ',' && level === 0) {
      args.push(src.slice(from, i).trim());
      from = i + 1;
    }
  }
  const last = src.slice(from, end).trim();
  if (last !== '') args.push(last);
  return args;
}

/** Whether `arg` is `{ audit: 'lazy' }` or a constant of this file declared as exactly that. */
function isLazy(src: string, arg: string | undefined): boolean {
  if (arg === undefined) return false;
  const literal = /^\{\s*audit:\s*'lazy'\s*,?\s*\}$/;
  if (literal.test(arg)) return true;
  if (!/^\w+$/.test(arg)) return false;
  const decl = new RegExp(`\\bconst\\s+${arg}\\b[^=]*=\\s*(\\{[^}]*\\})`).exec(src);
  return decl?.[1] !== undefined && literal.test(decl[1]);
}

function txCalls(src: string): TxCall[] {
  const masked = mask(src);
  const zitadelCalls = [...masked.matchAll(/\bzitadelCall\s*\(/g)].map((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    return [open, closeOf(masked, open)] as const;
  });
  const calls: TxCall[] = [];
  for (const m of masked.matchAll(/\bwithTx\s*\(/g)) {
    const start = m.index ?? 0;
    const open = start + m[0].length - 1;
    const end = closeOf(masked, open);
    const body = masked.slice(open + 1, end < 0 ? masked.length : end);
    const args = end < 0 ? [] : argsOf(src, masked, open, end);
    calls.push({
      line: src.slice(0, start).split('\n').length,
      fn: enclosingFunction(masked, start),
      end,
      hits: [...body.matchAll(NETWORK)].map((h) => h[0].replace(/\s+/g, '')),
      insideZitadelCall: zitadelCalls.some(([o, e]) => o < start && start < e),
      lazy: args.length >= 5 && isLazy(src, args[4]),
    });
  }
  return calls;
}

/** `file:line (fn): why` for every call that breaks a rule. `file` is relative to apps/api/src. */
function offenders(file: string, src: string): string[] {
  const out: string[] = [];
  for (const c of txCalls(src)) {
    const where = `${file}:${c.line} (${c.fn})`;
    const allowed = ALLOWED.some((a) => a.file === file && a.fn === c.fn);
    if (c.end < 0) out.push(`${where}: the withTx( call never closes; the scan cannot read it`);
    if (c.hits.length > 0 && !allowed)
      out.push(`${where}: calls ${c.hits.join(', ')} inside withTx`);
    if (c.insideZitadelCall && !allowed)
      out.push(`${where}: a zitadelCall() transaction not in ALLOWED`);
    if (c.insideZitadelCall && !c.lazy)
      out.push(`${where}: a zitadelCall() transaction without audit: 'lazy'`);
  }
  return out;
}

describe('no network I/O or nested withTx inside a withTx callback', () => {
  const files = sourceFiles(SRC_DIR).map((file) => ({
    rel: relative(SRC_DIR, file).replaceAll('\\', '/'),
    src: readFileSync(file, 'utf8'),
  }));

  it('scans the real source tree and reads every withTx call in it', () => {
    // A wrong root or a masking bug would scan nothing and pass.
    expect(files.some((f) => f.rel === 'platform/users/admin-users.controller.ts')).toBe(true);
    expect(files.some((f) => isTest(f.rel))).toBe(false);
    const calls = files.flatMap((f) => txCalls(f.src));
    expect(calls.length).toBeGreaterThan(200);
    expect(calls.filter((c) => c.end < 0)).toEqual([]);
  });

  it('has no offender in apps/api/src', () => {
    expect(files.flatMap((f) => offenders(f.rel, f.src))).toEqual([]);
  });

  it('every ALLOWED entry is a real lazy zitadelCall() transaction (no stale entries)', () => {
    for (const a of ALLOWED) {
      const src = files.find((f) => f.rel === a.file)?.src ?? '';
      const matching = txCalls(src).filter((c) => c.fn === a.fn);
      expect(matching, `${a.file} ${a.fn}`).toHaveLength(1);
      expect(matching[0]).toMatchObject({ insideZitadelCall: true, lazy: true });
    }
  });

  it('would catch an offender (the rules are not dead)', () => {
    const planted = `
class Planted {
  async direct(id: string) {
    await withTx(this.db, scope, actor, async (tx) => {
      const r = await fetch(\`https://idp.example/\${id}\`);
      await tx.insert(t).values({ r });
    });
  }

  async identity(id: string) {
    return withTx(this.db, scope, actor, (tx) => this.zitadel.lockUser(id));
  }

  async nested() {
    return withTx(this.db, scope, actor, (tx) => withTx(this.db, scope, actor, (t) => go(t)));
  }

  async viaService(b: unknown) {
    return zitadelCall(() => withTx(this.db, scope, actor, (tx) => this.users.invite(tx, b), { audit: 'lazy' }));
  }
}
`;
    expect(offenders('modules/planted.ts', planted)).toEqual([
      'modules/planted.ts:4 (direct): calls fetch( inside withTx',
      'modules/planted.ts:11 (identity): calls zitadel.lockUser( inside withTx',
      'modules/planted.ts:15 (nested): calls withTx( inside withTx',
      'modules/planted.ts:19 (viaService): a zitadelCall() transaction not in ALLOWED',
    ]);
  });

  it('flags an allowed zitadelCall() transaction that is not lazy', () => {
    const src = `
class AdminUsersController {
  async setRoles(id: string) {
    await zitadelCall(() =>
      withTx(this.db, scope, actor, async (tx) => {
        await this.users.setRoles(tx, id, roles);
      }),
    );
  }
}
`;
    expect(offenders('platform/users/admin-users.controller.ts', src)).toEqual([
      "platform/users/admin-users.controller.ts:5 (setRoles): a zitadelCall() transaction without audit: 'lazy'",
    ]);
  });

  it('ignores comments, strings and regex literals, and reads a lazy constant', () => {
    const fine = `
const CALLS: TxOptions = { audit: 'lazy' };
class Fine {
  async run() {
    await withTx(this.db, scope, actor, async (tx) => {
      // fetch(url) would hold the tenant lock; withTx( in a comment
      const note = 'fetch( and withTx( in a string';
      const re = /fetch\\(/;
      await tx.execute(sql\`SELECT \${note} -- zitadel.getUser(\`);
    });
    await zitadelCall(() => withTx(this.db, scope, actor, (tx) => go(tx), CALLS));
  }
}
`;
    const calls = txCalls(fine);
    expect(calls.map((c) => ({ hits: c.hits, lazy: c.lazy, end: c.end > 0 }))).toEqual([
      { hits: [], lazy: false, end: true },
      { hits: [], lazy: true, end: true },
    ]);
  });
});

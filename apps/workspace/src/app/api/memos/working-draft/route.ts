import { forbiddenOrigin, isSameOrigin, jsonResponse, routeSession } from '@/lib/bff';
import { authorizeDraftScope, type DraftOperation } from '@/lib/memo-working-draft-access';
import {
  DraftStoreUnavailableError,
  memoDraftAccount,
  readDraft,
  tombstoneDraft,
  writeDraft,
  type DraftOwner,
  type WriteOutcome,
} from '@/lib/memo-working-draft';
import {
  MEMO_DRAFT_LIMITS,
  MemoDraftDeleteBodySchema,
  MemoDraftPutBodySchema,
  type MemoDraftConflictBody,
  type MemoDraftScopeId,
} from '@/lib/memo-working-draft-types';
import type { Session } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The memo form's durable working copy: `/api/memos/working-draft?memoId=<uuid>` (omit `memoId` for the new-memo
 * draft). GET reads, PUT saves with compare-and-set on `revision`, DELETE writes a revisioned tombstone. The owner
 * of a draft is always the authenticated session, never a field of the request. See memo-working-draft.ts for the
 * storage and concurrency rules and memo-working-draft-types.ts for the wire shapes.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status: number, message: string): Response =>
  jsonResponse({ error: { message } }, status);

type Scope = { ok: true; id: MemoDraftScopeId } | { ok: false; response: Response };

/** `memoId` absent: the new-memo draft. Present, it must be exactly one UUID. */
function scopeOf(req: Request): Scope {
  const ids = new URL(req.url).searchParams.getAll('memoId');
  if (ids.length === 0) return { ok: true, id: null };
  const [id] = ids;
  if (ids.length > 1 || id === undefined || !UUID.test(id)) {
    return { ok: false, response: fail(400, 'That is not a memo id.') };
  }
  return { ok: true, id: id.toLowerCase() };
}

/** Reads the body up to `max` bytes. Null when it is longer, so a lying Content-Length cannot buy memory. */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (req.body === null) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function snapshotResponse(outcome: WriteOutcome): Response {
  if (outcome.ok) return jsonResponse(outcome.snapshot);
  const body: MemoDraftConflictBody = {
    error: {
      message: 'This draft changed somewhere else. Review the saved version before continuing.',
      code: 'conflict',
    },
    current: outcome.current,
  };
  return jsonResponse(body, 409);
}

/** Session, scope and access, in that order. A Response means stop and return it. */
async function gate(
  req: Request,
  operation: DraftOperation,
): Promise<{ session: Session; scopeId: MemoDraftScopeId } | Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const scope = scopeOf(req);
  if (!scope.ok) return scope.response;
  if (req.headers.get('x-bos-draft-account') !== memoDraftAccount(session)) {
    return fail(403, 'The signed-in account changed. Reopen this memo to continue.');
  }
  const denial = await authorizeDraftScope(session, scope.id, operation);
  if (denial !== null) return fail(denial.status, denial.message);
  return { session, scopeId: scope.id };
}

const ownerOf = (session: Session): DraftOwner => ({ orgId: session.orgId, sub: session.sub });

/** Runs a store call and turns a Valkey failure into a 503, the only thing the browser learns about it. */
async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DraftStoreUnavailableError) {
      return fail(503, 'Draft saving is unavailable right now. Keep this page open and try again.');
    }
    throw err;
  }
}

/** The announced body size, or a refusal. The real limit is enforced while reading. */
function checkLength(req: Request): Response | null {
  const length = Number(req.headers.get('content-length') ?? '');
  if (!Number.isFinite(length) || length <= 0)
    return fail(411, 'The request must announce its size.');
  if (length > MEMO_DRAFT_LIMITS.requestBytes) return fail(413, 'That draft is too large to save.');
  return null;
}

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

async function jsonBody(req: Request): Promise<Body> {
  const text = await readBounded(req, MEMO_DRAFT_LIMITS.requestBytes);
  if (text === null) return { ok: false, response: fail(413, 'That draft is too large to save.') };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: fail(400, 'The draft could not be read.') };
  }
}

export async function GET(req: Request): Promise<Response> {
  const passed = await gate(req, 'read');
  if (passed instanceof Response) return passed;
  return guarded(async () =>
    jsonResponse(await readDraft(ownerOf(passed.session), passed.scopeId)),
  );
}

export async function PUT(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const tooBig = checkLength(req);
  if (tooBig) return tooBig;
  const passed = await gate(req, 'write');
  if (passed instanceof Response) return passed;

  const raw = await jsonBody(req);
  if (!raw.ok) return raw.response;
  const parsed = MemoDraftPutBodySchema.safeParse(raw.value);
  if (!parsed.success) return fail(400, 'Check the draft: a field is missing or too long to save.');

  return guarded(async () =>
    snapshotResponse(
      await writeDraft(
        ownerOf(passed.session),
        passed.scopeId,
        parsed.data.revision,
        parsed.data.values,
      ),
    ),
  );
}

export async function DELETE(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const tooBig = checkLength(req);
  if (tooBig) return tooBig;
  const passed = await gate(req, 'delete');
  if (passed instanceof Response) return passed;

  const raw = await jsonBody(req);
  if (!raw.ok) return raw.response;
  const parsed = MemoDraftDeleteBodySchema.safeParse(raw.value);
  if (!parsed.success) return fail(400, 'The delete request must name the revision it saw.');

  return guarded(async () =>
    snapshotResponse(
      await tombstoneDraft(ownerOf(passed.session), passed.scopeId, parsed.data.revision),
    ),
  );
}

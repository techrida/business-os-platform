// Short-lived, single-use download links. Serves NFR Security: a link works for 60 s and once, so a link
// that leaks into a log, a chat or a browser history is useless a minute later.
//
// Token = base64url(JSON {v, u, exp, jti}) "." base64url(HMAC-SHA256(secret, first part)).
//   v   format version, u  document version id, exp  expiry in epoch seconds,
//   jti a random id (16 bytes, base64url), unique per link.
// The jti is what makes each link single-use on its own. Without it the payload (and so the signature) was the
// same for two links to one version issued in the same second, and the first download burned the second
// person's link. The first redemption claims `dl:<jti>` in Valkey with SET NX EX 120; a second try finds the
// key and is refused. EX is twice the 60 s lifetime, so the key outlives the link even with some clock drift.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const LINK_TTL_SECONDS = 60;
export const CLAIM_TTL_SECONDS = 120;
const MIN_SECRET_LENGTH = 32;

/** Valkey `SET key 1 NX EX ttl`: true if this call created the key, false if it already existed. */
export interface LinkStore {
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

/** `secret_missing`: DOCS_LINK_SECRET is unset or short, so links are refused (fail closed). */
export type LinkErrorKind = 'secret_missing' | 'invalid' | 'expired' | 'used';

export class LinkError extends Error {
  constructor(readonly kind: LinkErrorKind) {
    super(`download link: ${kind}`);
    this.name = 'LinkError';
  }
}

// 16 random bytes are 22 base64url characters. A token without a well-formed jti is refused.
const PayloadSchema = z.object({
  v: z.literal(1),
  u: z.guid(),
  exp: z.number().int(),
  jti: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

export class SignedLinks {
  constructor(
    private readonly secret: string | undefined,
    private readonly store: LinkStore,
    /** Injectable clock (epoch ms) so tests can move time without waiting. */
    private readonly now: () => number = Date.now,
  ) {}

  /** A link for one document version. Does not check the version's status: the caller does. */
  issue(versionId: string): { token: string; expiresAt: Date } {
    const secret = this.requireSecret();
    const exp = Math.floor(this.now() / 1000) + LINK_TTL_SECONDS;
    const jti = b64url(randomBytes(16));
    const payload = b64url(JSON.stringify({ v: 1, u: versionId, exp, jti }));
    return { token: `${payload}.${sign(secret, payload)}`, expiresAt: new Date(exp * 1000) };
  }

  /** Checks the token and burns it. Returns the version id; throws LinkError otherwise. */
  async redeem(token: string): Promise<string> {
    const secret = this.requireSecret();
    const [payload, signature, extra] = token.split('.');
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new LinkError('invalid');
    }
    // Verify the signature BEFORE touching Valkey, so garbage tokens cannot fill it with keys.
    const given = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(sign(secret, payload), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new LinkError('invalid');
    }
    let parsed: z.infer<typeof PayloadSchema>;
    try {
      parsed = PayloadSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new LinkError('invalid');
    }
    if (Math.floor(this.now() / 1000) > parsed.exp) throw new LinkError('expired');
    // Claim by the jti: it is inside the signed payload, so the caller cannot respell it into a second key.
    if (!(await this.store.claim(`dl:${parsed.jti}`, CLAIM_TTL_SECONDS))) {
      throw new LinkError('used');
    }
    return parsed.u;
  }

  private requireSecret(): string {
    if (this.secret === undefined || this.secret.length < MIN_SECRET_LENGTH) {
      throw new LinkError('secret_missing');
    }
    return this.secret;
  }
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

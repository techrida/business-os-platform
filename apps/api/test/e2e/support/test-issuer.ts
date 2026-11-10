// A stand-in for ZITADEL: serves OIDC discovery and a JWKS from 127.0.0.1 and signs tokens with
// a key the API trusts only because discovery told it to. The API runs its normal verification
// code against it, so there is no auth switch in src for tests to flip.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const KID = 'e2e-key-1';

export interface MintOptions {
  /** `iss` claim. Default: this issuer's own URL. */
  issuer?: string;
  /** `aud` claim. Default: none, so pass it (or put `aud` in the claims) for a token the API accepts. */
  audience?: string | string[];
  /** Seconds since the epoch. Default: now. */
  issuedAt?: number;
  /** Seconds since the epoch. Default: five minutes from now. */
  expiresAt?: number;
  /**
   * `trusted` signs with the key published at /jwks. `forged` signs with a different key but the
   * SAME `kid`, so the API finds the published key and the signature check is what fails.
   */
  signWith?: 'trusted' | 'forged';
}

export interface TestIssuer {
  /** Base URL, also the `iss` of valid tokens and the OIDC_ISSUER the API is configured with. */
  readonly url: string;
  /** Signs an RS256 token. Every default produces a token the API accepts (given a valid `aud`). */
  mint(claims: JWTPayload, options?: MintOptions): Promise<string>;
  /** An `alg: none` token with the same claims handling as {@link mint}. */
  mintUnsigned(claims: JWTPayload, options?: MintOptions): string;
  close(): Promise<void>;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export async function startTestIssuer(): Promise<TestIssuer> {
  const trusted = await generateKeyPair('RS256', { extractable: true });
  const forged = await generateKeyPair('RS256', { extractable: true });
  const publicJwk: JWK = {
    ...(await exportJWK(trusted.publicKey)),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };

  let url = '';
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (path === '/.well-known/openid-configuration') {
      // `issuer` must equal OIDC_ISSUER character for character (OIDC Discovery 1.0 §4.3).
      json({ issuer: url, jwks_uri: `${url}/jwks` });
    } else if (path === '/jwks') {
      json({ keys: [publicJwk] });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const keyFor = (signWith: MintOptions['signWith']): PrivateKey =>
    signWith === 'forged' ? forged.privateKey : trusted.privateKey;

  return {
    url,
    async mint(claims, options = {}) {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'at+jwt' })
        .setIssuer(options.issuer ?? url)
        .setIssuedAt(options.issuedAt ?? nowSeconds())
        .setExpirationTime(options.expiresAt ?? nowSeconds() + 300);
      if (options.audience !== undefined) jwt.setAudience(options.audience);
      return jwt.sign(keyFor(options.signWith));
    },
    mintUnsigned(claims, options = {}) {
      const jwt = new UnsecuredJWT(claims)
        .setIssuer(options.issuer ?? url)
        .setIssuedAt(options.issuedAt ?? nowSeconds())
        .setExpirationTime(options.expiresAt ?? nowSeconds() + 300);
      if (options.audience !== undefined) jwt.setAudience(options.audience);
      return jwt.encode();
    },
    async close() {
      // jose's fetch keeps connections alive; without this the test worker would not exit.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export interface ZitadelClaimsInput {
  /** The API's ZITADEL project id: part of `aud` and of the roles claim name. */
  projectId: string;
  /** The web client's id. ZITADEL puts it in `aud` next to the project id. */
  clientId: string;
  /** `sub`. */
  userId: string;
  /** The user's own organization (`urn:zitadel:iam:user:resourceowner:id`). */
  orgId: string;
  roles: readonly string[];
}

/**
 * The claim set of a real ZITADEL access token, as seen in a live seed run: `aud` is an array
 * holding the project id and the client id, roles sit under a claim named after the project, and
 * each role maps org id to org domain. (`iss`, `iat` and `exp` are added by {@link TestIssuer.mint}.)
 */
export function zitadelClaims(input: ZitadelClaimsInput): JWTPayload {
  return {
    sub: input.userId,
    aud: [input.projectId, input.clientId],
    azp: input.clientId,
    [`urn:zitadel:iam:org:project:${input.projectId}:roles`]: Object.fromEntries(
      input.roles.map((role) => [role, { [input.orgId]: 'org.example.test' }]),
    ),
    'urn:zitadel:iam:user:resourceowner:id': input.orgId,
  };
}

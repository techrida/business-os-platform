// TOTP (Time-based One-Time Password, RFC 6238) code generator for the seed's personas.
//
// Why the seed needs it: P1 turns on `forceMfa` in the login policy (NFR security: every human
// signs in with a second factor). The seed registers an authenticator for each persona, then has
// to prove it owns the secret by sending one valid code (`VerifyTOTPRegistration`). The same
// secret is written to `.dev/personas.json` so the Playwright login helper can type codes later.
//
// ZITADEL's authenticator is the standard one: HMAC-SHA1, 6 digits, 30 second step, base32 secret.
// Those are otplib 13's defaults, so only the secret and the clock are passed in.
import { generateSync } from 'otplib';

/**
 * The 6-digit code for `secret` (base32, as ZITADEL's `RegisterTOTP` returns it) at `at`.
 * `at` defaults to now; tests pass a fixed instant so the answer is reproducible.
 */
export function totpCode(secret: string, at: Date = new Date()): string {
  return generateSync({
    secret,
    strategy: 'totp',
    // otplib wants whole Unix seconds. A time step is 30 s, so flooring never changes the code.
    epoch: Math.floor(at.getTime() / 1000),
  });
}

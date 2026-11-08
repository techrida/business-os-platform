import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JWTPayload } from 'jose';

import { type AuthenticatedRequest, type MappedClaims, mapClaims } from './claims';
import { AUTH_OPTIONS, type AuthOptions, AuthUnavailableError, JwtVerifier } from './jwt-verifier';
import { IS_PUBLIC_KEY } from './public.decorator';

// One message for every 401, whatever the reason, so a caller cannot probe which check failed.
const UNAUTHENTICATED = 'Missing or invalid bearer token';
const UNAVAILABLE = 'Authentication is temporarily unavailable';
const NO_ORG = 'Token is not bound to an organization';

// Case-insensitive scheme (RFC 7235), one or more spaces, then a single token with no spaces.
const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Global guard (APP_GUARD): every route needs a valid ZITADEL access token unless it is marked
 * `@Public()`. Every path that is not an explicit success throws, so the default is "deny".
 *
 * It reads no environment flags and no header except `Authorization`. Tests use the same code
 * with a different trusted issuer and key, never a switch that turns checks off.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Method metadata wins over class metadata, so a public controller can still be read on its
    // own, and either level can open a route.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    // P0 only serves HTTP. Any other transport has no Authorization header to check: deny.
    if (context.getType() !== 'http') throw new UnauthorizedException(UNAUTHENTICATED);

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = BEARER.exec(req.headers.authorization ?? '');
    const token = match?.[1];
    if (token === undefined) throw new UnauthorizedException(UNAUTHENTICATED);

    const payload = await this.verifyOrThrow(token);

    let claims: MappedClaims;
    try {
      claims = mapClaims(payload, this.options.audience);
    } catch {
      throw new UnauthorizedException(UNAUTHENTICATED);
    }
    // A real, valid user whose token names no organization: we know who, but not for which
    // tenant, so it is "forbidden", not "unauthenticated".
    if (claims.zitadelOrgId === null) throw new ForbiddenException(NO_ORG);

    // `requiredClaims` already demands exp; this narrows the type and keeps the guard closed if
    // that option is ever dropped.
    if (typeof payload.exp !== 'number') throw new UnauthorizedException(UNAUTHENTICATED);

    req.auth = {
      userId: claims.userId,
      zitadelOrgId: claims.zitadelOrgId,
      roles: claims.roles,
      tokenExp: payload.exp,
    };
    return true;
  }

  private async verifyOrThrow(token: string): Promise<JWTPayload> {
    try {
      return await this.verifier.verify(token);
    } catch (err) {
      if (err instanceof AuthUnavailableError) {
        // Log the reason (never the token); the client only learns "try again later".
        this.logger.warn(`Token check unavailable: ${err.message}`);
        throw new ServiceUnavailableException(UNAVAILABLE);
      }
      // Any jose verification error, and anything unexpected, is a 401. The jose message stays
      // out of the response.
      throw new UnauthorizedException(UNAUTHENTICATED);
    }
  }
}

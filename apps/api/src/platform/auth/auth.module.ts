import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppConfig } from '../config/config';
import { JwksStatus } from '../health/jwks-status';
import { AuthGuard } from './auth.guard';
import { AUTH_OPTIONS, type AuthOptions, JwtVerifier } from './jwt-verifier';

/**
 * Authentication: the token verifier and the global deny-by-default guard.
 *
 * Exports `JwksStatus` because HealthModule imports this module for /health/ready. APP_GUARD
 * applies app-wide no matter which module registers it, and Nest creates this module once.
 */
@Module({
  providers: [
    {
      // The only place auth touches configuration: AppConfig is parsed and validated by U3's
      // config module. Nothing in platform/auth reads the environment directly.
      provide: AUTH_OPTIONS,
      inject: [AppConfig],
      useFactory: (config: AppConfig): AuthOptions => ({
        issuer: config.OIDC_ISSUER,
        audience: config.OIDC_AUDIENCE,
        allowedAzp: config.OIDC_ALLOWED_AZP,
      }),
    },
    JwtVerifier,
    { provide: JwksStatus, useExisting: JwtVerifier },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [JwtVerifier, JwksStatus],
})
export class AuthModule {}

/**
 * Readiness signal from the auth module: have the identity provider's signing keys been loaded
 * at least once? Without them the API cannot verify a single token, so it is not ready.
 *
 * An abstract class is both the type and the Nest injection token. AuthModule provides it
 * (`{ provide: JwksStatus, useExisting: JwtVerifier }`) and must export it, because HealthModule
 * imports AuthModule to receive it.
 */
export abstract class JwksStatus {
  abstract isJwksReady(): Promise<boolean>;
}

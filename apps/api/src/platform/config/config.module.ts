import { type DynamicModule, Module } from '@nestjs/common';

import {
  AppConfig,
  CoreConfig,
  type Env,
  type ServiceName,
  loadAppConfig,
  loadCoreConfig,
} from './config';

export { AppConfig, CoreConfig } from './config';

/**
 * Zod-parsed, frozen configuration that fails the boot on the first bad value. We do not use
 * @nestjs/config: it adds a layer and Zod already gives typed, validated output.
 *
 * Global, so any module can inject `CoreConfig` (both processes) or `AppConfig` (API only)
 * without importing this module.
 */
@Module({})
export class ConfigModule {
  /** `env` is injectable for tests; the entry points pass nothing and get `process.env`. */
  static forRoot(options: { service: ServiceName; env?: Env }): DynamicModule {
    const env = options.env ?? process.env;
    if (options.service === 'api') {
      return {
        module: ConfigModule,
        global: true,
        providers: [
          { provide: AppConfig, useFactory: () => loadAppConfig(env) },
          // Same object under the core token, so Obs, Db and Queue inject one type in both processes.
          { provide: CoreConfig, useExisting: AppConfig },
        ],
        exports: [AppConfig, CoreConfig],
      };
    }
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: CoreConfig, useFactory: () => loadCoreConfig(env, options.service) }],
      exports: [CoreConfig],
    };
  }
}

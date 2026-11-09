// Field-level encryption (M20). Services only, no routes, so the worker could import it too; today only the
// API config carries the keyring (FIELD_ENC_KEYS), so only API modules (vendor bank accounts) import this.
import { Module } from '@nestjs/common';

import { AppConfig } from '../config/config';
import { FieldCipher } from './field-cipher';

@Module({
  providers: [
    {
      provide: FieldCipher,
      inject: [AppConfig],
      useFactory: (config: AppConfig): FieldCipher => {
        // Production config already refuses a missing keyring; this stops a dev or test boot that needs
        // encryption from starting without one. The message names the variable only.
        if (config.FIELD_ENC_KEYS === undefined) {
          throw new Error('FIELD_ENC_KEYS is not set: field encryption needs a keyring');
        }
        return new FieldCipher(config.FIELD_ENC_KEYS);
      },
    },
  ],
  exports: [FieldCipher],
})
export class CryptoModule {}

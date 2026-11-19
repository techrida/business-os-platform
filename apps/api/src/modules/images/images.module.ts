// Images module (U12, D33): logos and profile pictures are documents of the owner types in @bos/contracts images.ts.
// It imports DocumentsModule for DocumentsService; AuthzModule and the database are global. ImageOwnerRegistrar
// registers the image owner policies when the module starts. Only AppModule imports this module.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { ImagesController } from './images.controller';
import { ImageOwnerRegistrar } from './images.registrar';
import { drizzleImagePointers, IMAGE_POINTER_STORE, ImagesService } from './images.service';

@Module({
  imports: [DocumentsModule, SettingsModule, AuditModule],
  controllers: [ImagesController],
  providers: [
    ImageOwnerRegistrar,
    ImagesService,
    { provide: IMAGE_POINTER_STORE, useFactory: drizzleImagePointers },
  ],
})
export class ImagesModule {}

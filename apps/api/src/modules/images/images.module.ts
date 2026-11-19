// Images module (U12, D33): logos and profile pictures are documents of the owner types in @bos/contracts images.ts.
// It imports DocumentsModule for DocumentsService; AuthzModule and the database are global. ImageOwnerRegistrar
// registers the image owner policies when the module starts. Only AppModule imports this module.
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../platform/documents/documents.module';
import { ImageOwnerRegistrar } from './images.registrar';

@Module({
  imports: [DocumentsModule],
  providers: [ImageOwnerRegistrar],
})
export class ImagesModule {}

// Registers the four image owner policies (image-owner.policies.ts) with DocumentsService when ImagesModule starts.
// registerOwner throws on a duplicate owner type, so only ImagesModule provides this, and only AppModule imports it.
// Anything that uploads an image at boot (the legacy-logo migrator) must run after this: import ImagesModule, or
// work in onApplicationBootstrap, which Nest calls after every onModuleInit.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { drizzleImageOwnerLoaders, imageOwnerPolicies } from './image-owner.policies';

@Injectable()
export class ImageOwnerRegistrar implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    for (const policy of imageOwnerPolicies(drizzleImageOwnerLoaders(this.db))) {
      this.documents.registerOwner(policy);
    }
  }
}

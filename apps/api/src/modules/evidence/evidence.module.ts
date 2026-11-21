// Evidence uploads (round 5 P2). Registers the `evidence` document owner policy with DocumentsService when the module
// starts (registerOwner throws on a duplicate, so only AppModule imports this module) and serves the per-kind
// upload routes. AuthzModule and the database are global.
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { EvidenceCaller } from './evidence.caller';
import { EvidenceDocumentsController } from './evidence-documents.controller';
import { EVIDENCE_RECORD_LOADER, EvidenceDocumentsService } from './evidence-documents.service';
import {
  drizzleEvidenceRecordLoader,
  EvidenceOwnerPolicy,
  type EvidenceRecordLoader,
} from './evidence-owner.policy';

@Injectable()
export class EvidenceOwnerRegistrar implements OnModuleInit {
  constructor(
    @Inject(EVIDENCE_RECORD_LOADER) private readonly load: EvidenceRecordLoader,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.documents.registerOwner(new EvidenceOwnerPolicy(this.load));
  }
}

@Module({
  imports: [DocumentsModule],
  controllers: [EvidenceDocumentsController],
  providers: [
    {
      provide: EVIDENCE_RECORD_LOADER,
      inject: [DB],
      useFactory: (db: Db) => drizzleEvidenceRecordLoader(db),
    },
    EvidenceCaller,
    EvidenceDocumentsService,
    EvidenceOwnerRegistrar,
  ],
})
export class EvidenceModule {}

// TestMemo module (owner: U8): the throwaway document type that exercises the whole kernel; deleted in P2.
// It imports the kernel modules it calls: approvals (submit and the decision callback), documents (owner
// policy and the "all attachments clean" check), settings (numbering and NPR money) and notify (the nudge
// after commit). AuthzModule and the database are global, so they are not listed. Only AppModule imports
// this module: the worker never calls onDecided.
import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { DocumentLogoModule } from '../images/document-logo.resolver';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { NotifyModule } from '../../platform/notify/notify.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { TestMemoCaller } from './test-memo.caller';
import { TestMemoController } from './test-memo.controller';
import { TestMemoService } from './test-memo.service';

@Module({
  // DocumentLogoModule: the letterhead's logo bytes (the directory shows them live, submit freezes them).
  imports: [ApprovalsModule, DocumentsModule, SettingsModule, NotifyModule, DocumentLogoModule],
  controllers: [TestMemoController],
  providers: [TestMemoService, TestMemoCaller],
})
export class TestMemoModule {}

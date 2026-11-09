// Payment-proof uploads module (P3 U13 part 2): serves /v1/portal/payment-proofs and /v1/payment-proofs. Uploads go
// through DocumentsService under the `payment_intake` owner type, which PaymentsModule registers when it starts, so AppModule must import
// PaymentsModule as well (the registry lookup happens per request, so the import order does not matter).
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../platform/documents/documents.module';
import { PaymentProofsService } from './payment-proofs.service';
import { PortalPaymentProofsController } from './portal-payment-proofs.controller';
import { StaffPaymentProofsController } from './staff-payment-proofs.controller';

@Module({
  imports: [DocumentsModule],
  controllers: [PortalPaymentProofsController, StaffPaymentProofsController],
  providers: [PaymentProofsService],
})
export class PaymentProofsModule {}

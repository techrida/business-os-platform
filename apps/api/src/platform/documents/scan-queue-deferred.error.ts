import { ServiceUnavailableException } from '@nestjs/common';
import type { DocumentVersionDto } from '@bos/contracts';

/**
 * The file was received and recorded (quarantined, with its sha256), but its docs.scan job could not be queued. The bytes
 * are kept and the stuck-scan sweeper queues the scan. The upload route answers 202 with `version`; the one-step image
 * upload deletes the picture and asks the user to upload again. It is a 503 for any caller that does not handle it.
 */
export class ScanQueueDeferredError extends ServiceUnavailableException {
  constructor(readonly version: DocumentVersionDto) {
    super(
      'The file was received, but its virus scan could not be queued yet. It is scanned as soon as the queue is back.',
    );
  }
}

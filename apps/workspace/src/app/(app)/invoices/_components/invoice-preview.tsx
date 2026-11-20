'use client';

import { Button } from '@/components/ui/button';
import { FilePreviewDialog } from '@/components/ui/file-preview-dialog';
import { Icon } from '@/components/ui/icon';
import { toast } from '@/components/ui/toast';

/**
 * The issued invoice's PDF in the shared viewer (round 4, R4c2): one "Preparing PDF" that checks again by itself until
 * the file is there, Download that keeps a refusal in the app, and, for a viewer who may issue the invoice (the
 * permission of the action that triggers the render), Retry on a render that was given up.
 */
export function InvoicePreview({
  documentUrl,
  number,
  mayRetry,
}: {
  documentUrl: string;
  number: string;
  mayRetry: boolean;
}) {
  return (
    <FilePreviewDialog
      name={`${number.replaceAll('/', '-')}.pdf`}
      mimeType="application/pdf"
      previewUrl={`${documentUrl}/preview`}
      downloadUrl={documentUrl}
      retryUrl={mayRetry ? `${documentUrl}/retry` : undefined}
      pollWhilePreparing
      downloadInApp
      trigger={
        <Button variant="secondary">
          <Icon name="file-text" size={18} /> View PDF
        </Button>
      }
      onDownload={() => toast.info('Download started')}
    />
  );
}

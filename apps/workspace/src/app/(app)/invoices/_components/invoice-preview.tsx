'use client';

import { Button } from '@/components/ui/button';
import { FilePreviewDialog } from '@/components/ui/file-preview-dialog';
import { Icon } from '@/components/ui/icon';
import { toast } from '@/components/ui/toast';

export function InvoicePreview({ documentUrl, number }: { documentUrl: string; number: string }) {
  return (
    <FilePreviewDialog
      name={`${number.replaceAll('/', '-')}.pdf`}
      mimeType="application/pdf"
      previewUrl={`${documentUrl}/preview`}
      downloadUrl={documentUrl}
      trigger={
        <Button variant="secondary">
          <Icon name="file-text" size={18} /> View PDF
        </Button>
      }
      onDownload={() => toast.info('Download started')}
    />
  );
}

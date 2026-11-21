'use client';

import type { FileView } from '@/components/p2/crm/verification-file';
import { useDocumentScan } from '@/components/ui/use-document-scan';

/** The scan watch for a verification case's file, through the case's own documents route. */
export function useFileScan(caseId: string, initial: FileView | null, enabled: boolean) {
  return useDocumentScan(`/verification/${caseId}/documents`, initial, enabled);
}

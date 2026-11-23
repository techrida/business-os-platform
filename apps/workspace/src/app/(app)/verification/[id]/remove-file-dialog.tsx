'use client';

import type { ChecklistItem } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { removeDocumentAction, type CaseFormState } from '../case-actions';
import styles from '../verification.module.css';
import { Tooltip } from '@/components/ui/tooltip';

export function RemoveFileDialog({
  caseId,
  version,
  itemKey,
  label,
  filename,
  reopens,
  disabled,
  onRemoved,
}: {
  caseId: string;
  version: number;
  itemKey: ChecklistItem['key'];
  label: string;
  filename: string;
  reopens: boolean;
  disabled: boolean;
  onRemoved: () => void;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [request, setRequest] = useState<{ version: number; state: CaseFormState } | null>(null);

  async function detach() {
    if (!request || inFlight.current || request.state.reload) return false;
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('key', itemKey);
    form.set('expectedVersion', String(request.version));
    form.set('idempotencyKey', request.state.key);
    inFlight.current = true;
    try {
      const result = await removeDocumentAction(form);
      if (result.error) {
        setRequest({ ...request, state: result });
        return false;
      }
      toast.success('File removed');
      onRemoved();
      return true;
    } catch {
      setRequest({
        ...request,
        state: { key: request.state.key, error: 'Removal could not be confirmed. Try again.' },
      });
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <ConfirmDialog
      trigger={
        <Tooltip content={`Remove ${filename}`}>
          <Button
            size="small"
            variant="ghost"
            disabled={disabled}
            className={styles.remove}
            aria-label={`Remove ${filename}`}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6" />
            </svg>
          </Button>
        </Tooltip>
      }
      open={request !== null}
      onOpenChange={(next) =>
        setRequest(next ? { version, state: { key: crypto.randomUUID() } } : null)
      }
      title={`Remove ${filename}?`}
      description={`This clears the file and expiry date from ${label}.${reopens ? ' The case returns to draft.' : ''}`}
      destructive
      confirmLabel="Remove file"
      onConfirm={detach}
    >
      {request?.state.error ? (
        <Alert
          tone="error"
          role="alert"
          actions={
            request.state.reload ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setRequest(null);
                  router.refresh();
                }}
              >
                Reload this case
              </Button>
            ) : null
          }
        >
          {request.state.error}
        </Alert>
      ) : null}
    </ConfirmDialog>
  );
}

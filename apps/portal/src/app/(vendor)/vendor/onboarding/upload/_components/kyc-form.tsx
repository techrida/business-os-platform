'use client';

import type { VendorKycDocType } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/portal/alert';
import { Field } from '@/components/portal/field';
import quotation from '@/components/portal/quotation.module.css';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Select } from '@/components/ui/select';

import { FileUpload } from '../../../_upload/file-upload';
import styles from '../../../_upload/upload.module.css';
import { type KycFormState, submitKycDocumentAction } from '../actions';

export interface KycChoice {
  docType: VendorKycDocType;
  /** The document's name and where it stands, for example `Bank proof (not uploaded)`. */
  label: string;
}

/**
 * Send one KYC document. A Client Component so the file uploads as it is chosen and the typed
 * values survive a refusal. What it submits goes to a server action. The Idempotency-Key and the
 * uploaded document id live in the form, so a retry after a timeout sends the very same request.
 * The expiry date shows only for a tax clearance, which is per fiscal year.
 */
export function KycForm({
  idempotencyKey,
  choices,
  initialDocType,
  today,
  initialState,
}: {
  idempotencyKey: string;
  choices: readonly KycChoice[];
  initialDocType: VendorKycDocType;
  today: string;
  initialState?: KycFormState | undefined;
}) {
  const [state, formAction, pending] = useActionState<KycFormState, FormData>(
    submitKycDocumentAction,
    initialState ?? { key: idempotencyKey },
  );
  const fe = state.fieldErrors ?? {};

  // Controlled: React 19 resets uncontrolled fields after every action.
  const [docType, setDocType] = useState<string>(initialDocType);
  const [validUntil, setValidUntil] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  const busy = pending || uploading;

  return (
    <form action={formAction} className={`${quotation.form} ${styles.formFrame}`}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      {documentId ? <input type="hidden" name="documentId" value={documentId} /> : null}

      {state.error ? (
        <Alert ref={errorRef} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      <Field label="Document" error={fe.docType}>
        {(control) => (
          <Select
            name="docType"
            required
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            {...control}
          >
            {choices.map((c) => (
              <option key={c.docType} value={c.docType}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {docType === 'tax_clearance' ? (
        <Field
          label="Valid until"
          hint="The date on the certificate when it stops being valid."
          error={fe.validUntil}
        >
          {(control) => (
            <DatePicker
              name="validUntil"
              required
              min={today}
              value={validUntil}
              onChange={setValidUntil}
              {...control}
            />
          )}
        </Field>
      ) : null}

      <FileUpload
        endpoint="/vendor/onboarding/upload/file"
        label="File"
        hint="A PDF or a picture (PNG, JPEG or WebP), up to 25 MB."
        error={fe.file}
        onDocument={setDocumentId}
        onBusy={setUploading}
      />

      <div className={quotation.buttons}>
        <Button type="submit" disabled={busy}>
          {pending ? 'Sending…' : 'Send document'}
        </Button>
        <a href="/vendor">Cancel</a>
      </div>
      <p className={quotation.liveStatus} role="status">
        {pending ? 'Sending your document' : ''}
      </p>
    </form>
  );
}

'use client';

import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ComboboxOption } from '@/components/ui/combobox-model';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Input } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { toast } from '@/components/ui/toast';
import { guessMime } from '@/lib/kernel-ui';

import { PickExisting, type PickSearcher } from '../../procurement/pick-existing';

import styles from '../payables.module.css';

export interface BillEntryHeader {
  /** The vendors the picker lists; `description` is the tax id the search also matches. */
  vendors: readonly { id: string; name: string; description?: string | undefined }[];
  /** There are more vendors than `vendors` holds: typing asks the server for matches. */
  searchVendors?: boolean;
  /**
   * The orders a bill can be entered against (the payables picker, no purchase order read needed), each
   * with its vendor and the text the picker shows. Only the chosen vendor's orders are offered.
   */
  orders?: readonly { id: string; vendorId: string; label: string }[];
  vendorPartyId?: string;
  vendorName?: string;
  purchaseOrderId?: string;
  /** Today as YYYY-MM-DD in the tenant's calendar: the invoice date starts here and stays editable. */
  today?: string;
}

/** Vendors matching the typed words, from the BFF (the page holds only the first of a long list). */
const searchVendors: PickSearcher = async (query, signal) => {
  const res = await fetch(`/payables/vendor-search?${new URLSearchParams({ q: query })}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`Vendor search failed with ${res.status}`);
  const body = (await res.json()) as { vendors?: ComboboxOption[] };
  return body.vendors ?? [];
};

/** Header and invoice upload for an entry that did not come from a portal submission. */
export function BillHeaderInputs({
  entry,
  errors,
  pending,
  onReady,
}: {
  entry: BillEntryHeader;
  errors: Record<string, string>;
  pending: boolean;
  onReady: (ready: boolean) => void;
}) {
  const router = useRouter();
  const [vendorId, setVendorId] = useState(entry.vendorPartyId ?? '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(entry.today ?? '');
  const [documentId, setDocumentId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = uploading || pending;
  const [vendorLabel, setVendorLabel] = useState('');
  const vendorOptions: ComboboxOption[] = entry.vendors.map((v) => ({
    id: v.id,
    label: v.name,
    ...(v.description === undefined ? {} : { description: v.description }),
  }));
  const vendorOrders = vendorId ? (entry.orders ?? []).filter((o) => o.vendorId === vendorId) : [];

  // An order shows its number and status, and the vendor it is for (the picker is searchable by either).
  const chosenVendorName = vendorOptions.find((v) => v.id === vendorId)?.label ?? vendorLabel;
  const orderOptions: ComboboxOption[] = vendorOrders.map((o) => ({
    id: o.id,
    label: o.label,
    ...(chosenVendorName === '' ? {} : { description: chosenVendorName }),
  }));

  async function upload() {
    setProblem('');
    if (uploading || pending) return;
    if (!vendorId) {
      setProblem('Choose a vendor before uploading the invoice.');
      return;
    }
    if (!file || file.size === 0) {
      setProblem('Choose a non-empty invoice file.');
      fileRef.current?.focus();
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setProblem('The invoice file must be at most 25 MB.');
      return;
    }
    const mime = guessMime(file.name, file.type);
    if (!(ALLOWED_MIME as readonly string[]).includes(mime)) {
      setProblem('Choose a PDF, image, Office document or CSV invoice.');
      return;
    }
    setUploading(true);
    try {
      const response = await fetch('/payables/bill-documents', {
        method: 'POST',
        headers: {
          'content-type': mime,
          'x-file-name': encodeURIComponent(file.name),
          'x-vendor-id': vendorId,
        },
        body: file,
      });
      const data = (await response.json()) as { documentId?: string; error?: { message?: string } };
      if (!response.ok || typeof data.documentId !== 'string') {
        setProblem(data.error?.message ?? 'The invoice upload did not finish. Try again.');
        return;
      }
      setDocumentId(data.documentId);
      onReady(true);
      toast.success('Invoice uploaded');
    } catch {
      setProblem('The invoice upload was interrupted. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="purchaseOrderId" value={entry.purchaseOrderId ?? ''} />
      <div className={styles.lineFields}>
        {entry.vendorPartyId ? (
          <>
            <input type="hidden" name="vendorPartyId" value={entry.vendorPartyId} />
            <Field label="Vendor">
              {(control) => (
                <Input
                  value={entry.vendorName ?? 'Vendor name unavailable'}
                  readOnly
                  {...control}
                />
              )}
            </Field>
          </>
        ) : (
          <Field label="Vendor" error={errors['vendorPartyId']}>
            {(control) => (
              <PickExisting
                control={control}
                name="vendorPartyId"
                options={vendorOptions}
                value={vendorId}
                disabled={busy}
                required
                search={entry.searchVendors ? searchVendors : undefined}
                placeholder="Search a vendor by name or PAN"
                emptyText="No vendors to choose from."
                noMatchText="No vendor matches. Ask Procurement to add the vendor."
                onChange={(id, option) => {
                  setVendorId(id);
                  setVendorLabel(option?.label ?? '');
                  setDocumentId('');
                  onReady(false);
                }}
              />
            )}
          </Field>
        )}
        {vendorOrders.length > 0 ? (
          <Field
            label="Purchase order"
            optional
            hint="Pick the order this invoice bills. The page reloads with the order's lines."
          >
            {(control) => (
              <PickExisting
                control={control}
                // Not read by the save: picking an order reloads the page with it as ?po=.
                name="orderPicker"
                options={orderOptions}
                value=""
                disabled={busy}
                placeholder="Search by order number"
                noMatchText="No purchase order matches."
                onChange={(id) => {
                  if (id !== '') router.push(`/payables/bills/new?po=${encodeURIComponent(id)}`);
                }}
              />
            )}
          </Field>
        ) : null}
        <Field label="Vendor invoice number" error={errors['vendorInvoiceNo']}>
          {(control) => (
            <Input
              name="vendorInvoiceNo"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              maxLength={64}
              required
              {...control}
            />
          )}
        </Field>
        <Field label="Invoice date (AD)" error={errors['invoiceDate']}>
          {(control) => (
            <DatePicker
              name="invoiceDate"
              value={invoiceDate}
              onChange={setInvoiceDate}
              // A vendor invoice cannot be dated after today in the tenant's calendar.
              max={entry.today}
              required
              {...control}
            />
          )}
        </Field>
      </div>
      <Field
        label="Invoice file"
        hint="Up to 25 MB. Upload the vendor's original invoice before creating the bill."
        error={errors['documentId']}
      >
        {(control) => (
          // The native picker covers the zone, invisible, so a click, a drop or the keyboard all reach it.
          <div className={styles.drop}>
            <Icon name="file-text" size={24} />
            {file !== null ? (
              <span className={styles.fileName}>{file.name}</span>
            ) : (
              <span>Drop the invoice here or choose a file</span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept={ALLOWED_MIME.join(',')}
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setDocumentId('');
                onReady(false);
              }}
              {...control}
            />
          </div>
        )}
      </Field>
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !vendorId || !file}
          onClick={() => {
            void upload();
          }}
        >
          {uploading ? 'Uploading invoice…' : 'Upload invoice'}
        </Button>
      </div>
      {problem ? (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      ) : null}
      {documentId ? (
        <p role="status" className={styles.note}>
          The invoice must scan clean before the bill can be submitted for approval.
        </p>
      ) : null}
    </>
  );
}

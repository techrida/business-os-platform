'use server';

import { VendorKycDocumentSubmissionBodySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { todayInKathmandu } from '@/components/portal/quotation-status';
import { submitVendorKycDocument } from '@/lib/api.vendor-writes';

import {
  failed,
  type FormState,
  keyOf,
  NOT_A_VENDOR,
  text,
  UUID,
  vendorSession,
} from '../../_upload/action-kit';

/**
 * Put an uploaded file on a KYC checklist item, for the vendor. The form carries an
 * Idempotency-Key the page generated once per render, and the key and the uploaded document id
 * stay in the form across a retry, so a double click, or a retry after a timeout, records the
 * document once. The vendor comes from the signed-in user (the body has no party or vendor id),
 * and server actions run no layout, so this checks for itself that the session is a vendor's.
 */

export type KycField = 'docType' | 'file' | 'validUntil';
export type KycFormState = FormState<KycField>;

const HERE = '/vendor/onboarding/upload';

const FIELD_MESSAGE: Record<KycField, string> = {
  docType: 'Choose which document you are sending.',
  file: 'Add the document as a PDF or a picture.',
  validUntil: 'Enter the date this certificate expires: today or later.',
};

export async function submitKycDocumentAction(
  prev: KycFormState,
  form: FormData,
): Promise<KycFormState> {
  const session = await vendorSession(HERE);
  const key = keyOf(form, prev);
  if (!session) return { key, error: NOT_A_VENDOR };

  const docType = text(form, 'docType');
  const documentId = text(form, 'documentId');
  const validUntil = text(form, 'validUntil');
  // The expiry only travels with a tax clearance, the one document that is per fiscal year.
  const candidate = {
    docType,
    documentId: UUID.test(documentId) ? documentId : '',
    ...(docType === 'tax_clearance' && validUntil !== '' ? { validUntil } : {}),
  };

  const parsed = VendorKycDocumentSubmissionBodySchema.safeParse(candidate);
  const fieldErrors: Partial<Record<KycField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      const field: KycField | undefined =
        head === 'documentId'
          ? 'file'
          : head === 'docType' || head === 'validUntil'
            ? head
            : undefined;
      if (field) fieldErrors[field] = FIELD_MESSAGE[field];
    }
  }
  if (
    candidate.docType === 'tax_clearance' &&
    validUntil !== '' &&
    validUntil < todayInKathmandu()
  ) {
    fieldErrors.validUntil = FIELD_MESSAGE.validUntil;
  }
  if (!parsed.success || fieldErrors.validUntil !== undefined) {
    // Nothing reached the API, so the same key is still unused.
    return { key, fieldErrors };
  }

  try {
    await submitVendorKycDocument(session, parsed.data, key);
  } catch (err) {
    return failed<KycField>(err, key, HERE, {
      noun: 'document',
      forbidden:
        'Your account cannot send documents right now. Please contact the person you work with at our company.',
    });
  }
  revalidatePath('/vendor');
  // `redirect` throws, so it stays outside the try block.
  redirect(`${HERE}?sent=1`);
}

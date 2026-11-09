import type {
  VendorKycDocType,
  VendorPortalBillStatus,
  VendorPortalOnboardingView,
  VendorStatus,
  VendorVisiblePoStatus,
} from '@bos/contracts';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';
interface Look {
  label: string;
  tone: Tone;
}

/** How an issued purchase order's state reads to the vendor. */
export const PO_STATUS_LOOK: Record<VendorVisiblePoStatus, Look> = {
  issued: { label: 'Issued', tone: 'info' },
  partially_received: { label: 'Partly received', tone: 'warning' },
  fully_received: { label: 'Fully received', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
  short_closed: { label: 'Closed short', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'error' },
};

/** The coarse bill status, in words that name what the vendor can expect next. */
export const BILL_STATUS_LOOK: Record<VendorPortalBillStatus, Look> = {
  received: { label: 'Received', tone: 'info' },
  under_review: { label: 'Being checked', tone: 'warning' },
  approved_for_payment: { label: 'Approved for payment', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'error' },
};

export const VENDOR_STATUS_LOOK: Record<VendorStatus, Look & { summary: string }> = {
  draft: {
    label: 'Setting up',
    tone: 'neutral',
    summary: 'Upload the documents below. Orders and bills open once your company is approved.',
  },
  pending_kyc: {
    label: 'Documents needed',
    tone: 'warning',
    summary: 'Upload the documents below. Orders and bills open once your company is approved.',
  },
  under_review: {
    label: 'Documents being checked',
    tone: 'info',
    summary:
      'We have your documents and are checking them. Orders and bills open once your company is approved.',
  },
  approved: {
    label: 'Approved',
    tone: 'success',
    summary: 'Your company is approved. You can see your purchase orders and bills.',
  },
  suspended: {
    label: 'Suspended',
    tone: 'warning',
    summary:
      'Your account is suspended. You can still view your orders and bills, but cannot send us anything new.',
  },
  blocked: {
    label: 'Closed',
    tone: 'error',
    summary:
      'Your account is closed to the portal. Contact the person you work with at our company.',
  },
  archived: {
    label: 'Archived',
    tone: 'neutral',
    summary:
      'Your account is closed to the portal. Contact the person you work with at our company.',
  },
};

export const KYC_DOC_LABEL: Record<VendorKycDocType, string> = {
  pan_certificate: 'PAN certificate',
  vat_certificate: 'VAT certificate',
  company_registration: 'Company registration',
  tax_clearance: 'Tax clearance certificate',
  bank_proof: 'Bank proof',
  proprietor_citizenship: 'Proprietor citizenship',
  foreign_registration: 'Foreign registration',
};

type KycState = VendorPortalOnboardingView['documents'][number]['state'];

export const KYC_STATE_LOOK: Record<KycState, Look> = {
  missing: { label: 'Not uploaded', tone: 'neutral' },
  submitted: { label: 'Received', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'error' },
  expired: { label: 'Expired', tone: 'warning' },
};

/**
 * A server quantity (`120.0000`) without its trailing zeros (`120`). Text only, never arithmetic:
 * the browser never works a figure out.
 */
export function trimQuantity(q: string): string {
  return q.includes('.') ? q.replace(/\.?0+$/, '') : q;
}

// Maps internal quotation rows to the whitelist a customer may see (`CustomerQuotationView`). The PDF
// renderer and the portal API are given this view and nothing else, so the NFR "a customer sees only what we
// meant to show" holds even if a caller passes whole rows: the input types pick named columns, and the view is
// built field by field (nothing is spread) and then parsed by the strict schema.
import {
  CustomerQuotationViewSchema,
  PaymentMilestoneSchema,
  PrintAddressSchema,
  isCustomerVisibleStatus,
  type CustomerQuotationView,
  type CustomerVisibleStatus,
  type PortalDisplay,
} from '@bos/contracts';
import type {
  customerContacts,
  customers,
  paymentTerms,
  quotationLines,
  quotations,
  quotationTaxSummary,
  quotationVersions,
} from '@bos/db';

import { paymentScheduleAmounts } from '../drafting/payment-schedule';

type Row<T extends { $inferSelect: object }> = T['$inferSelect'];

/**
 * The file name of a quotation PDF, as the render job stores it and the portal shows it. Document numbers carry
 * the fiscal year as `2083/84`, and the documents module takes a bare file name only (no path separator, see
 * CreateDocumentBodySchema), so each `/` becomes `-`: QT-2083/84-00001 revision 1 is QT-2083-84-00001-R1.pdf.
 */
export function quotationPdfFilename(number: string, revisionNo: number): string {
  return `${number.replaceAll('/', '-')}-R${revisionNo}.pdf`;
}

/** The columns of a version the mapper reads. Everything else on the row (cost, margin, FX, NPR) is never touched. */
export type CustomerViewVersion = Pick<
  Row<typeof quotationVersions>,
  | 'id'
  | 'revisionNo'
  | 'status'
  | 'rejectionSource'
  | 'currency'
  | 'issueDate'
  | 'validUntil'
  | 'scope'
  | 'assumptions'
  | 'exclusions'
  | 'termsAndConditions'
  | 'deliveryTimeline'
  | 'paymentSchedule'
  | 'subtotal'
  | 'discountAmount'
  | 'taxableAmount'
  | 'taxAmount'
  | 'total'
  | 'renderState'
  | 'renderedDocumentId'
  | 'renderedSha256'
>;

/**
 * The selling legal entity as the document shows it. The organizations table holds only the legal name today
 * (PAN and address come with a later unit), so the caller supplies the printable block. `address` is the
 * `entity.address` setting, `{ line, city, country }`: its country is the entity's own (FX9).
 */
export interface CustomerViewIssuer {
  legalName: string;
  panVatNo: string | null;
  address: unknown;
}

export interface CustomerViewInput {
  version: CustomerViewVersion;
  quotation: Pick<Row<typeof quotations>, 'number'>;
  customer: Pick<
    Row<typeof customers>,
    'legalName' | 'panVatNo' | 'country' | 'addressLine' | 'addressCity'
  >;
  contact: Pick<Row<typeof customerContacts>, 'fullName' | 'emailNorm'> | null;
  paymentTerm: Pick<Row<typeof paymentTerms>, 'name'> | null;
  lines: readonly Pick<
    Row<typeof quotationLines>,
    'lineNo' | 'description' | 'uom' | 'quantity' | 'unitPrice' | 'gross'
  >[];
  taxSummary: readonly Pick<Row<typeof quotationTaxSummary>, 'label' | 'rate' | 'base' | 'tax'>[];
  issuer: CustomerViewIssuer;
  /**
   * The number grouping and date pattern the portal draws this version with: the portal passes the ones frozen with
   * the version (else the live settings). The PDF renderer ignores it (it reads the snapshot itself) and passes
   * `defaultPortalDisplay()`.
   */
  display: PortalDisplay;
  /**
   * True once the rendered PDF's malware scan came back clean. The file goes in the view only then; the
   * default is deny.
   */
  renderedScanClean?: boolean;
  /**
   * The portal's "this PDF will not come without the team" flag (render given up, or the scan refused the file). Only
   * the portal passes it; the view carries the key only then, so the PDF render path builds the same view as before.
   */
  renderFailed?: boolean;
}

/** The version is not one a customer may see (draft, in approval, never sent, cancelled, internal rejection). */
export class QuotationNotCustomerVisibleError extends Error {
  constructor(readonly status: string) {
    super(`A ${status} quotation version is not visible to a customer`);
    this.name = 'QuotationNotCustomerVisibleError';
  }
}

/** numeric(18,4) and numeric(7,4) come back padded ("12.0000", "13.0000"); show "12" and "13", keep "2.5". */
const trimZeros = (value: string): string =>
  value.includes('.') ? value.replace(/\.?0+$/, '') : value;

/** The issuer's `{ line, city, country }` split into the view's party country and its street lines. */
function issuerAddressOf(raw: unknown) {
  const { line, city, country } = PrintAddressSchema.parse(raw);
  return { country, address: { line, city } };
}

/**
 * Who the view is for. `portal` (the default, so nothing loosens by accident) shows only the states a customer
 * may see. `render` is the PDF job: it may also draw an `approved` version, which no customer can see yet, as the
 * document that will be sent. Every other hidden state stays hidden in both.
 */
export type CustomerViewPurpose = 'portal' | 'render';

export interface CustomerViewOptions {
  purpose?: CustomerViewPurpose;
}

export function toCustomerQuotationView(
  input: CustomerViewInput,
  options: CustomerViewOptions = {},
): CustomerQuotationView {
  const { version, quotation, customer, contact, paymentTerm, issuer } = input;

  let status: CustomerVisibleStatus;
  if (options.purpose === 'render' && version.status === 'approved') {
    // The PDF is what the customer will receive, so it is drawn as `sent`. That also keeps its content identical
    // whatever state the version is in later.
    status = 'sent';
  } else if (
    // A rejection is visible only when the customer made it; an internal one must look like a 404.
    isCustomerVisibleStatus(version.status) &&
    !(version.status === 'rejected' && version.rejectionSource !== 'customer')
  ) {
    status = version.status;
  } else {
    throw new QuotationNotCustomerVisibleError(version.status);
  }

  // The same split the staff API makes (D36), so the portal and the PDF never differ from the workspace.
  const schedule = paymentScheduleAmounts(
    version.total,
    PaymentMilestoneSchema.array().parse(version.paymentSchedule),
  );

  const file =
    input.renderedScanClean === true &&
    version.renderState === 'rendered' &&
    version.renderedDocumentId !== null &&
    version.renderedSha256 !== null
      ? {
          documentId: version.renderedDocumentId,
          filename: quotationPdfFilename(quotation.number, version.revisionNo),
          sha256: version.renderedSha256.toString('hex'),
        }
      : null;
  const issuerAddress = issuerAddressOf(issuer.address);

  return CustomerQuotationViewSchema.parse({
    id: version.id,
    number: quotation.number,
    revisionNo: version.revisionNo,
    status,
    issueDate: version.issueDate,
    validUntil: version.validUntil,
    currency: version.currency,
    issuer: {
      legalName: issuer.legalName,
      panVatNo: issuer.panVatNo,
      country: issuerAddress.country,
      address: issuerAddress.address,
    },
    customer: {
      legalName: customer.legalName,
      panVatNo: customer.panVatNo,
      country: customer.country,
      address: { line: customer.addressLine, city: customer.addressCity },
    },
    contact: contact ? { fullName: contact.fullName, email: contact.emailNorm } : null,
    scope: version.scope,
    assumptions: version.assumptions,
    exclusions: version.exclusions,
    termsAndConditions: version.termsAndConditions,
    deliveryTimeline: version.deliveryTimeline,
    paymentTermName: paymentTerm ? paymentTerm.name : null,
    paymentSchedule: schedule.map((m) => ({
      label: m.label,
      percent: m.percent,
      amount: m.amount,
      ...(m.dueDescription === undefined ? {} : { dueDescription: m.dueDescription }),
    })),
    lines: [...input.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity: trimZeros(l.quantity),
        unitPrice: l.unitPrice,
        amount: l.gross,
      })),
    totals: {
      subtotal: version.subtotal,
      discountAmount: version.discountAmount,
      taxableAmount: version.taxableAmount,
      taxAmount: version.taxAmount,
      total: version.total,
    },
    taxSummary: input.taxSummary.map((t) => ({
      label: t.label,
      percent: trimZeros(t.rate),
      base: t.base,
      tax: t.tax,
    })),
    display: {
      numberSystems: {
        NPR: input.display.numberSystems.NPR,
        INR: input.display.numberSystems.INR,
        USD: input.display.numberSystems.USD,
      },
      dateFormat: input.display.dateFormat,
    },
    file,
    // Sent only when true, so an older portal's strict parser still accepts every document that is not failed.
    ...(input.renderFailed === true && file === null ? { renderFailed: true } : {}),
  });
}

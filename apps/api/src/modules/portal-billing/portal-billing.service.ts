// The customer portal's invoice reads (P3 unit U13, part 1; plan A16, done check 2). Serves the NFR "a customer sees
// only what we meant to show":
// - only a customer principal with a party gets in (assertCustomerCaller, 403 before any query);
// - every query is `forCounterparty(invoices, 'customer', partyId)` in the acting entity, and only when that entity is
//   the tenant's default one: a portal user may name another entity with X-Entity-Id, and sees nothing there;
// - only issued tax invoices, credit notes and debit notes are read (the SQL filter is the authority). A draft,
//   submitted, returned, approved or discarded invoice, a proforma, another party's invoice and an unknown id all
//   answer the same 404, on every `:id` route, so existence never leaks;
// - the PDF state (view `file` and `renderFailed`, the document route's 409 and 424) comes from generatedPdfState, the
//   same derivation as the staff download, and is told apart only after the invoice passed the visibility check;
// - the views are built field by field and parsed with the strict contract schemas: no staff field (status, NPR
//   value, FX rate, approval, editor, content hash) can ride along. The seller contact is four named keys of the
//   saved company profile, never the whole profile (no logo, display name or website).
// Money is derived on read (plan A8): the open amount comes from open_item_balances and allocations, never from a
// stored field. "Today" is the Kathmandu calendar day of the server clock (A10), as in ReceivablesService.
import {
  documentSellerContact,
  CustomerInvoiceViewSchema,
  PartySnapshotSchema,
  PortalInvoiceListItemSchema,
  type CustomerInvoiceView,
  type DocumentFormatSnapshot,
  type DocumentVersionDto,
  type InvoiceSettlement,
  type PortalInvoiceListItem,
  type SignedLinkDto,
} from '@bos/contracts';
import {
  documents,
  documentVersions,
  invoiceLines,
  invoicePrintLog,
  invoices,
  invoiceTaxSummary,
  openItemBalances,
  organizations,
  scoped,
} from '@bos/db';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { Principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { firstPrintFormat } from '../invoices/invoice-mapping';
import { INVOICE_OWNER_TYPE } from '../invoices/invoice-owner.policy';
import { renderGivenUp } from '../invoices/render/render-failures';
import {
  generatedPdfState,
  renderStateOf,
  type GeneratedPdfState,
} from '../invoices/render/render-state';
import { assertCustomerCaller, PortalCaller } from '../portal/portal.caller';
import { kathmanduDay, settlementRow } from '../receivables/receivables.rules';

/** Injection token for a test clock; production falls back to the system time. */
export const PORTAL_BILLING_CLOCK = Symbol('PORTAL_BILLING_CLOCK');

/** The kinds a customer sees. A proforma is not a tax document and is not in the contract views. */
export const PORTAL_INVOICE_KINDS = ['tax_invoice', 'credit_note', 'debit_note'] as const;
type PortalInvoiceKind = (typeof PORTAL_INVOICE_KINDS)[number];

/** One fixed refusal for every hidden id on every route: the bodies are byte-identical. */
const notFound = () => new NotFoundException('Invoice not found');
/** The caller's invoice whose PDF is still being prepared. Plain messages, as the 404: the portal reads the status. */
const pdfNotReady = () => new ConflictException('The PDF of this invoice is still being prepared');
/** 424 Failed Dependency: the render was given up, or the virus scan refused the file. */
const pdfFailed = () => new HttpException('The PDF could not be prepared', 424);

/** What the portal shows of one invoice's money position: the settlement less the staff-side keys. */
export type PortalSettlement = Pick<
  InvoiceSettlement,
  'invoiceId' | 'currency' | 'total' | 'openAmount' | 'dueDate' | 'daysOverdue' | 'settlement'
>;

/** One issued invoice of the caller with its derived balance, as read for the list and the settlement. */
export interface PortalBalanceRow {
  invoiceId: string;
  kind: PortalInvoiceKind;
  number: string;
  customerId: string;
  currency: InvoiceSettlement['currency'];
  issueDate: string;
  dueDate: string | null;
  /** The invoice's own total. */
  invoiceTotal: string;
  /** The debit item's amount; null when the invoice has no open item. */
  itemAmount: string | null;
  /** Net of allocations on the item; null when it has no open item. */
  allocated: string | null;
  /** The part of `allocated` whose credit item is a credit note. */
  credited: string;
}

/**
 * The settlement a customer sees. A tax invoice or debit note is settled from its debit open item (the receivables
 * rule `settlementRow`); one without an item counts as nothing allocated. A credit note owes the customer nothing, so
 * it reads as fully settled (`credited`, open 0.00): the portal shows the settlement next to every document, and a
 * 404 here would hide a credit note the detail route shows.
 */
export function toPortalSettlement(row: PortalBalanceRow, today: string): PortalSettlement {
  if (row.kind === 'credit_note') {
    return {
      invoiceId: row.invoiceId,
      currency: row.currency,
      total: row.invoiceTotal,
      openAmount: '0.00',
      dueDate: row.dueDate,
      daysOverdue: 0,
      settlement: 'credited',
    };
  }
  const s = settlementRow(
    {
      invoiceId: row.invoiceId,
      number: row.number,
      kind: row.kind,
      customerId: row.customerId,
      currency: row.currency,
      issueDate: row.issueDate,
      dueDate: row.dueDate,
      total: row.itemAmount ?? row.invoiceTotal,
      allocated: row.allocated ?? '0',
      credited: row.credited,
    },
    today,
  );
  return {
    invoiceId: s.invoiceId,
    currency: s.currency,
    total: s.total,
    openAmount: s.openAmount,
    dueDate: s.dueDate,
    daysOverdue: s.daysOverdue,
    settlement: s.settlement,
  };
}

/**
 * The invoice's PDF among the files of owner `invoice`/<id>: only the render job adds files there (InvoiceOwnerPolicy).
 * Per document, the newest version that was not rejected counts; with several documents, the one whose counting
 * version is newest wins. Undefined when there is none.
 */
export function pickInvoiceFile(
  versions: readonly DocumentVersionDto[],
): DocumentVersionDto | undefined {
  const newestPerDocument = new Map<string, DocumentVersionDto>();
  for (const v of versions) {
    if (v.status === 'rejected') continue;
    const seen = newestPerDocument.get(v.documentId);
    if (seen === undefined || v.version > seen.version) newestPerDocument.set(v.documentId, v);
  }
  let picked: DocumentVersionDto | undefined;
  for (const v of newestPerDocument.values()) {
    if (picked === undefined || v.createdAt > picked.createdAt) picked = v;
  }
  return picked;
}

/** The `file` of the customer view: only a clean version with a hash, so a quarantined file's data never shows. */
export function toCustomerFile(v: DocumentVersionDto | undefined): CustomerInvoiceView['file'] {
  if (v === undefined || v.status !== 'clean' || v.sha256 === null) return null;
  return { documentId: v.documentId, filename: v.filename, sha256: v.sha256 };
}

const trimZeros = (value: string): string =>
  value.includes('.') ? value.replace(/\.?0+$/, '') : value;

type InvoiceRow = typeof invoices.$inferSelect;
type LineRow = typeof invoiceLines.$inferSelect;
type TaxRow = typeof invoiceTaxSummary.$inferSelect;
type SellerContact = NonNullable<CustomerInvoiceView['sellerContact']>;

/**
 * The customer-safe part of the saved company profile (`entity.profile`): phones, email and the signatory. The shared
 * contracts mapper names them key by key (the PDF freezes the same four at print 1), and is null when the stored value
 * does not validate: the page then shows no contact block rather than failing.
 */
export function toSellerContact(rawProfile: unknown): SellerContact | null {
  return documentSellerContact(rawProfile);
}

/** What the view adds beyond the invoice rows: the original print's format, the seller's contact, the PDF state. */
export interface CustomerInvoiceExtras {
  format: DocumentFormatSnapshot | null;
  sellerContact: SellerContact | null;
  /** The PDF could not be prepared (renderStateOf is `failed`). False when left out. */
  renderFailed?: boolean;
}

/** The invoice PDF as generatedPdfState sees it, and the customer `file` of its clean original (null otherwise). */
export interface CustomerPdf {
  state: GeneratedPdfState;
  file: CustomerInvoiceView['file'];
}

/** The strict customer view, field by field. Throws on a row that is not an issued portal kind (a bug, never data). */
export function toCustomerInvoiceView(
  invoice: InvoiceRow,
  lines: readonly LineRow[],
  taxSummary: readonly TaxRow[],
  file: CustomerInvoiceView['file'],
  extras: CustomerInvoiceExtras,
): CustomerInvoiceView {
  return CustomerInvoiceViewSchema.parse({
    id: invoice.id,
    kind: invoice.kind,
    number: invoice.number,
    issueDate: invoice.issueDate,
    issueDateBs: invoice.issueDateBs,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    seller: PartySnapshotSchema.parse(invoice.sellerSnapshot),
    buyer: PartySnapshotSchema.parse(invoice.buyerSnapshot),
    lines: [...lines]
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
      subtotal: invoice.subtotal,
      discountAmount: invoice.discountAmount,
      taxableAmount: invoice.taxableVatAmount,
      exemptAmount: invoice.exemptAmount,
      zeroRatedAmount: invoice.zeroRatedAmount,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
    },
    taxSummary: taxSummary.map((t) => ({
      label: t.label,
      percent: trimZeros(t.rate),
      base: t.base,
      tax: t.tax,
    })),
    file,
    ...(extras.renderFailed === true ? { renderFailed: true } : {}),
    format: extras.format,
    sellerContact: extras.sellerContact,
  });
}

@Injectable()
export class PortalBillingService {
  constructor(
    private readonly caller: PortalCaller,
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
    @Optional()
    @Inject(PORTAL_BILLING_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The caller's issued invoices and notes, newest issue date first. */
  async list(): Promise<PortalInvoiceListItem[]> {
    const p = this.customer();
    const today = kathmanduDay(this.clock());
    const rows = await this.balances(p);
    return rows.map((r) =>
      PortalInvoiceListItemSchema.parse({
        id: r.invoiceId,
        kind: r.kind,
        number: r.number,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        currency: r.currency,
        total: r.invoiceTotal,
        openAmount: toPortalSettlement(r, today).openAmount,
      }),
    );
  }

  /** One issued invoice as the customer sees it. 404 unless it is the caller's and visible. */
  async get(id: string): Promise<CustomerInvoiceView> {
    const p = this.customer();
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(visibleTo(p, eq(invoices.id, id)))
      .limit(1);
    if (invoice === undefined) throw notFound();
    const s = scoped(scopeOf(p));
    const lines = await this.db
      .select()
      .from(invoiceLines)
      .where(s.where(invoiceLines, eq(invoiceLines.invoiceId, invoice.id)))
      .orderBy(asc(invoiceLines.lineNo));
    const taxSummary = await this.db
      .select()
      .from(invoiceTaxSummary)
      .where(s.where(invoiceTaxSummary, eq(invoiceTaxSummary.invoiceId, invoice.id)))
      .orderBy(asc(invoiceTaxSummary.label));
    const pdf = await this.invoicePdf(p, invoice.id);
    // Print 1 is the original: its stored format is the one every copy of the PDF is drawn with.
    const original = await this.db
      .select({ printNo: invoicePrintLog.printNo, renderFormat: invoicePrintLog.renderFormat })
      .from(invoicePrintLog)
      .where(
        s.where(
          invoicePrintLog,
          and(eq(invoicePrintLog.invoiceId, invoice.id), eq(invoicePrintLog.printNo, 1)),
        ),
      )
      .limit(1);
    const sellerContact = toSellerContact(await this.settings.get(scopeOf(p), 'entity.profile'));
    return toCustomerInvoiceView(invoice, lines, taxSummary, pdf.file, {
      format: firstPrintFormat(original),
      sellerContact,
      renderFailed: renderStateOf(pdf.state) === 'failed',
    });
  }

  /** The derived money position of one issued invoice. 404 unless it is the caller's and visible. */
  async settlement(id: string): Promise<PortalSettlement> {
    const p = this.customer();
    const [row] = await this.balances(p, id);
    if (row === undefined) throw notFound();
    return toPortalSettlement(row, kathmanduDay(this.clock()));
  }

  /**
   * A 60 s single-use link to the clean original of the invoice PDF. 404 unless the invoice is the caller's and
   * visible; then 409 while the PDF is being prepared, 424 when its render was given up or the virus scan refused it,
   * and the same 404 when the file went away before the link was issued. DocumentsService.issueLinkForOwner asks no
   * permission (customers hold no `documents.read`), so this method is the whole authorization; the documents module
   * then re-checks the owner, the scope and the newest version's status itself.
   */
  async documentLink(id: string): Promise<SignedLinkDto> {
    const p = this.customer();
    const [invoice] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(visibleTo(p, eq(invoices.id, id)))
      .limit(1);
    if (invoice === undefined) throw notFound();
    const { state } = await this.invoicePdf(p, invoice.id);
    if (state.kind === 'preparing') throw pdfNotReady();
    if (state.kind !== 'clean') throw pdfFailed();
    try {
      return await this.documents.issueLinkForOwner(
        scopeOf(p),
        { ownerType: INVOICE_OWNER_TYPE, ownerId: invoice.id },
        state.documentId,
      );
    } catch (error) {
      // Its own 404 has another message; keep this route's refusal the one body.
      if (error instanceof NotFoundException) throw notFound();
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------- internals

  private customer(): Principal {
    const p = this.caller.current();
    assertCustomerCaller(p);
    return p;
  }

  /**
   * The PDF of a visible invoice, read the way InvoiceDocumentService.link reads it (no permission check: this module
   * authorized the caller already). Every upload of every live document, oldest document first and newest upload first
   * within it, plus the given-up flag; the file data is the clean upload generatedPdfState picked.
   */
  private async invoicePdf(p: Principal, invoiceId: string): Promise<CustomerPdf> {
    const scope = scopeOf(p);
    const { uploads, givenUp } = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          documentId: documents.id,
          status: documentVersions.status,
          filename: documentVersions.filename,
          sha256: documentVersions.sha256,
        })
        .from(documents)
        .innerJoin(
          documentVersions,
          and(
            eq(documentVersions.tenantId, documents.tenantId),
            eq(documentVersions.documentId, documents.id),
          ),
        )
        .where(
          scoped(scope).where(
            documents,
            and(
              eq(documents.ownerType, INVOICE_OWNER_TYPE),
              eq(documents.ownerId, invoiceId),
              isNull(documents.removedAt),
            ),
          ),
        )
        .orderBy(asc(documents.createdAt), asc(documents.id), desc(documentVersions.version));
      const given = await renderGivenUp(tx, {
        ...scope,
        ownerType: INVOICE_OWNER_TYPE,
        ownerId: invoiceId,
      });
      return { uploads: rows, givenUp: given };
    });
    const state = generatedPdfState(uploads, givenUp);
    if (state.kind !== 'clean') return { state, file: null };
    // generatedPdfState took the first clean upload in this order; rejected rows never are clean.
    const clean = uploads.find((u) => u.status === 'clean');
    const file =
      clean === undefined || clean.sha256 === null
        ? null
        : {
            documentId: clean.documentId,
            filename: clean.filename,
            sha256: clean.sha256.toString('hex'),
          };
    return { state, file };
  }

  /** The caller's visible invoices (or the one `id`) with their open item balance, newest first. */
  private async balances(p: Principal, id?: string): Promise<PortalBalanceRow[]> {
    // The net of allocations on the debit item whose credit item is a credit note (as ReceivablesService.statement).
    const credited = sql<string>`(
      SELECT COALESCE(sum(a."amount"), 0)::text
        FROM "app"."open_item_allocations" a
        JOIN "app"."open_items" c ON c."tenant_id" = a."tenant_id" AND c."id" = a."credit_item_id"
       WHERE a."tenant_id" = ${openItemBalances.tenantId}
         AND a."organization_id" = ${openItemBalances.organizationId}
         AND a."debit_item_id" = ${openItemBalances.openItemId}
         AND c."source_type" = 'credit_note')`;
    const rows = await this.db
      .select({
        invoiceId: invoices.id,
        kind: invoices.kind,
        number: invoices.number,
        customerId: invoices.customerPartyId,
        currency: invoices.currency,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        invoiceTotal: invoices.total,
        itemAmount: openItemBalances.amount,
        allocated: openItemBalances.allocatedAmount,
        credited,
      })
      .from(invoices)
      .leftJoin(
        openItemBalances,
        and(
          eq(openItemBalances.tenantId, invoices.tenantId),
          eq(openItemBalances.organizationId, invoices.organizationId),
          eq(openItemBalances.sourceId, invoices.id),
          sql`${openItemBalances.sourceType} = ${invoices.kind}`,
        ),
      )
      .where(visibleTo(p, id === undefined ? undefined : eq(invoices.id, id)))
      .orderBy(desc(invoices.issueDate), desc(invoices.number));
    return rows.map((r) => ({
      invoiceId: r.invoiceId,
      kind: r.kind as PortalInvoiceKind,
      number: r.number ?? '',
      customerId: r.customerId ?? '',
      currency: r.currency,
      issueDate: r.issueDate ?? '',
      dueDate: r.dueDate,
      invoiceTotal: r.invoiceTotal,
      itemAmount: r.itemAmount,
      allocated: r.allocated,
      credited: r.credited ?? '0',
    }));
  }
}

/** The acting entity: the only one any read touches. */
const scopeOf = (p: Principal): TxScope => ({
  tenantId: p.tenantId,
  organizationId: p.organizationId,
});

/**
 * The portal read filter: the caller's party in the acting entity (forCounterparty, ADR 0027 §5), only when that entity
 * is the tenant's default, and only issued documents of a portal kind. `extra` narrows further. Also used by the
 * milestones read, so a schedule line names only an invoice this module would show.
 */
export function visibleTo(p: Principal, extra?: SQL): SQL {
  // assertCustomerCaller ran first, so partyId is a non-empty string here.
  const partyId = p.partyId ?? '';
  const defaultEntity = sql`EXISTS (SELECT 1 FROM ${organizations}
      WHERE ${organizations.tenantId} = ${invoices.tenantId}
        AND ${organizations.id} = ${invoices.organizationId}
        AND ${organizations.isDefault})`;
  return scoped(scopeOf(p)).forCounterparty(
    invoices,
    'customer',
    partyId,
    and(
      eq(invoices.status, 'issued'),
      inArray(invoices.kind, [...PORTAL_INVOICE_KINDS]),
      defaultEntity,
      ...(extra === undefined ? [] : [extra]),
    ),
  );
}

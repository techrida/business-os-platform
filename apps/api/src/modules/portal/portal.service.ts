// The customer portal's read rules (P2 unit PA-2). Serves the NFR "a customer sees only what we meant to show":
// - only a customer principal with a party gets in (PortalCaller, 403 before any query);
// - the store limits every read to the caller's tenant, acting entity and party;
// - only customer-visible versions are listed or shown: sent, accepted, expired, superseded, and rejected when the
//   customer rejected it. Anything else, like a foreign or unknown id, is a 404, so existence never leaks;
// - the view is built by the strict mapper `toCustomerQuotationView`, never from a row.
// The `:id` of the portal is a version id: the view's `id` is the version id, and the portal reuses it for reload,
// accept and reject. The list shows, per quotation, the newest customer-visible version, so a revision that is
// still a draft never shows; the version sent before it stays listed (as `superseded`).
import {
  CurrencySchema,
  DateFormatSchema,
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  isCustomerVisibleStatus,
  NumberSystemsSchema,
  snapshotNumberSystems,
  type SignedLinkDto,
  PortalQuotationListItemSchema,
  type Currency,
  type CustomerQuotationView,
  type PortalDisplay,
  type PortalQuotationListItem,
} from '@bos/contracts';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { Principal } from '../../platform/authz/principal';
import type { TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { missingEvidence } from '../quotations/outcome/evidence-policy';
import { evidenceStatusOf } from '../quotations/outcome/evidence-state';
import { QUOTATION_OWNER_TYPE } from '../quotations/quotation-owner.policy';
import {
  QuotationNotCustomerVisibleError,
  toCustomerQuotationView,
} from '../quotations/render/customer-view';
import {
  buildIssuer,
  DocumentStyleInvalidError,
  IssuerIncompleteError,
  parseStoredDocumentStyle,
} from '../quotations/render/issuer';
import { quotationRenderGivenUp } from '../quotations/render/render-retry';
import { assertCustomerCaller, PortalCaller } from './portal.caller';
import {
  PORTAL_QUOTATION_STORE,
  type PortalQuotationStore,
  type PortalVersionHead,
} from './portal.store';
import { assertVendorCaller } from './vendor-portal.caller';

/** The same rule as the mapper: a visible status, and a rejection only when the customer made it. */
export function isPortalVisible(v: Pick<PortalVersionHead, 'status' | 'rejectionSource'>): boolean {
  return (
    isCustomerVisibleStatus(v.status) &&
    !(v.status === 'rejected' && v.rejectionSource !== 'customer')
  );
}

/**
 * A sent version the company has since closed: it was cancelled itself (a Lost deal), or it was replaced by a revision
 * that was then cancelled. The mailed link then says "no longer open" instead of "not found" (R6D, EF2 Q2/Q3).
 */
function isClosedToCustomer(source: {
  version: { status: PortalVersionHead['status'] };
  quotationCancelled: boolean;
}): boolean {
  return (
    source.version.status === 'cancelled' ||
    (source.version.status === 'superseded' && source.quotationCancelled)
  );
}

const notFound = () => new NotFoundException('Quotation not found');
/** The PDF of a visible version is still being prepared (rendered soon, or its file awaits the scan). */
const pdfNotReady = () =>
  new ConflictException({
    code: 'quotation_pdf_not_ready',
    message: 'The PDF of this quotation is not ready yet',
  });
/** 424 Failed Dependency: the PDF will not come without the team (render given up, or the scan refused the file). */
const pdfFailed = () =>
  new HttpException(
    { code: 'quotation_pdf_failed', message: 'The PDF could not be prepared' },
    424,
  );

/** The PDF of a visible version as the customer sees it: one answer for the view and the file route. */
export type PortalPdfState = 'ready' | 'pending' | 'failed';

type DisplaySettings = Pick<SettingsService, 'get'>;

/**
 * The selling company's display settings as they stand now. A stored value that fails its schema (a row edited by
 * hand) shows the default instead of failing the page: this only changes how numbers and dates are written.
 */
export async function liveDisplay(
  settings: DisplaySettings,
  scope: TxScope,
): Promise<PortalDisplay> {
  const [numberSystems, dateFormat] = await Promise.all([
    settings.get(scope, 'format.number_systems'),
    settings.get(scope, 'format.date'),
  ]);
  const systems = NumberSystemsSchema.safeParse(numberSystems);
  const date = DateFormatSchema.safeParse(dateFormat);
  return {
    numberSystems: systems.success ? systems.data : { ...DEFAULT_NUMBER_SYSTEMS },
    dateFormat: date.success ? date.data : DEFAULT_DATE_FORMAT,
  };
}

/**
 * The currencies the company has switched on now (D44), as CurrencyEnabledService enforces them: NPR first and always,
 * then each known code of the saved `currency.enabled` list (the contract default when nothing is saved). A stored
 * value that is not a list (a row edited by hand) offers NPR only, so a portal form never offers a currency the API
 * might refuse with 422 CURRENCY_NOT_ENABLED.
 */
export async function liveEnabledCurrencies(
  settings: DisplaySettings,
  scope: TxScope,
): Promise<Currency[]> {
  const stored: unknown = await settings.get(scope, 'currency.enabled');
  const known = Array.isArray(stored)
    ? stored.filter((c): c is Currency => CurrencySchema.safeParse(c).success)
    : [];
  return [...new Set<Currency>(['NPR', ...known])];
}

/**
 * The display a version was sent with: its frozen `document_style` snapshot (a legacy snapshot's single number
 * system applies to every currency; one without a date format printed the default). Undefined when the version
 * has no snapshot yet, or the stored one does not validate: the caller then uses the live settings.
 */
export function frozenDisplay(stored: unknown): PortalDisplay | undefined {
  if (stored === null || stored === undefined) return undefined;
  try {
    const snapshot = parseStoredDocumentStyle(stored);
    return {
      numberSystems: snapshotNumberSystems(snapshot),
      dateFormat: snapshot.dateFormat ?? DEFAULT_DATE_FORMAT,
    };
  } catch (error) {
    if (error instanceof DocumentStyleInvalidError) return undefined;
    throw error;
  }
}

/**
 * 403 unless `p` is an active customer or vendor portal principal with a party: the same checks as the customer
 * reads (assertCustomerCaller) and the vendor reads (assertVendorCaller). The route is open to any active
 * principal, so this is the whole authorization of the display read.
 */
function assertPortalCaller(p: Principal): void {
  if (p.status !== 'active') {
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'inactive_user',
    });
  }
  if (p.orgKind === 'vendor') assertVendorCaller(p);
  else assertCustomerCaller(p);
}

@Injectable()
export class PortalService {
  constructor(
    private readonly caller: PortalCaller,
    @Inject(PORTAL_QUOTATION_STORE) private readonly store: PortalQuotationStore,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
  ) {}

  /** The caller's quotations: the newest customer-visible version of each, newest issue date first. */
  async list(): Promise<PortalQuotationListItem[]> {
    const p = this.caller.current();
    assertCustomerCaller(p);
    const newest = new Map<string, PortalVersionHead>();
    for (const head of await this.store.listVersions(p)) {
      if (!isPortalVisible(head)) continue;
      const seen = newest.get(head.quotationId);
      if (seen === undefined || head.revisionNo > seen.revisionNo)
        newest.set(head.quotationId, head);
    }
    return [...newest.values()]
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.number.localeCompare(a.number))
      .map((h) =>
        // Field by field and strict, so nothing internal can ride along.
        PortalQuotationListItemSchema.parse({
          id: h.versionId,
          number: h.number,
          revisionNo: h.revisionNo,
          status: h.status,
          issueDate: h.issueDate,
          validUntil: h.validUntil,
          currency: h.currency,
          total: h.total,
        }),
      );
  }

  /** One version as the customer sees it. 404 unless it is the caller's and customer-visible. */
  async get(versionId: string): Promise<CustomerQuotationView> {
    const p = this.caller.current();
    assertCustomerCaller(p);
    const source = await this.store.loadView(p, versionId);
    // Decide visibility before any further read, so a hidden version costs no document or settings lookup.
    if (source !== undefined && source.sentAt !== null && isClosedToCustomer(source)) {
      // The customer was sent this version (the mail link names it), so its existence is no secret: say it is closed.
      throw new ConflictException({
        code: 'quotation_closed',
        message: 'This quotation is no longer open',
      });
    }
    if (source === undefined || !isPortalVisible(source.version)) throw notFound();
    const scope = scopeOf(p);

    let issuer;
    try {
      issuer = await buildIssuer(this.settings, scope, source.issuerLegalName);
    } catch (error) {
      if (error instanceof IssuerIncompleteError) {
        // A fixed body: which setting is missing is for the admin, not the customer.
        throw new ServiceUnavailableException({
          code: 'issuer_incomplete',
          message: 'This quotation cannot be shown right now',
        });
      }
      throw error;
    }

    // The grouping and dates the version was sent with; the live settings only before its first render.
    const display =
      frozenDisplay(source.documentStyle) ?? (await liveDisplay(this.settings, scope));

    const {
      issuerLegalName: _legalName,
      documentStyle: _documentStyle,
      renderAttempts,
      sentAt: _sentAt,
      quotationCancelled: _quotationCancelled,
      ...input
    } = source;
    const afterAcceptance =
      source.version.status === 'accepted'
        ? await this.afterAcceptance(p, scope, versionId)
        : undefined;
    const pdf = await this.pdfState(scope, { ...source.version, renderAttempts });
    try {
      const view = toCustomerQuotationView(
        {
          ...input,
          issuer,
          display,
          renderedScanClean: pdf === 'ready',
          renderFailed: pdf === 'failed',
        },
        { purpose: 'portal' },
      );
      return afterAcceptance === undefined ? view : { ...view, afterAcceptance };
    } catch (error) {
      if (error instanceof QuotationNotCustomerVisibleError) throw notFound();
      throw error;
    }
  }

  /**
   * F1-Q28: what the customer waits for after accepting. Pending until staff confirm the acceptance (one they
   * recorded themselves is confirmed); `needs` is what the entity's evidence policy asks beyond what the customer
   * gave, so the portal can say which document the team will ask for. Never a dead end: the acceptance stands.
   */
  private async afterAcceptance(
    p: Principal,
    scope: TxScope,
    versionId: string,
  ): Promise<CustomerQuotationView['afterAcceptance']> {
    const acceptance = await this.store.loadAcceptance(p, versionId);
    if (acceptance === undefined) return undefined;
    const status = evidenceStatusOf(acceptance, acceptance.confirmed ? true : null);
    if (status === 'confirmed') return { status, needs: [] };
    const policy = await this.settings.get(scope, 'sales.evidence_policy');
    return { status, needs: missingEvidence(policy, acceptance.evidenceKinds) };
  }

  /**
   * How the caller's company writes numbers and dates now, for lists and anything without a frozen snapshot, and the
   * currencies it has switched on, for the portal's payment and quotation forms. Any active customer or vendor portal
   * caller; the scope is the caller's acting (selling) entity.
   */
  async display(): Promise<PortalDisplay> {
    const p = this.caller.current();
    assertPortalCaller(p);
    const scope = scopeOf(p);
    const [display, enabledCurrencies] = await Promise.all([
      liveDisplay(this.settings, scope),
      liveEnabledCurrencies(this.settings, scope),
    ]);
    return { ...display, enabledCurrencies };
  }

  /**
   * A short-lived signed link to the frozen PDF of one version. 404 unless the version is the caller's and
   * customer-visible; then 409 `quotation_pdf_not_ready` while the PDF is being prepared, 424 `quotation_pdf_failed`
   * when it will not come without the team (render given up, or the scan refused the file). The document module then
   * re-checks the owner and the newest version's scan status itself. DocumentsService.issueLinkForOwner asks no
   * permission (customers hold no `documents.read`, which would also show them draft versions), so this method is the
   * whole authorization: caller, scope, visibility, scan. The link is scoped by the quotation's own tenant and entity
   * (the selling entity), read from its row.
   */
  async quotationPdfLink(versionId: string): Promise<SignedLinkDto> {
    const p = this.caller.current();
    assertCustomerCaller(p);
    const head = await this.store.loadDocumentHead(p, versionId);
    // Visibility first: a foreign or hidden version is the same plain 404 whatever its PDF is doing.
    if (head === undefined || !isPortalVisible(head)) throw notFound();
    const scope: TxScope = { tenantId: head.tenantId, organizationId: head.organizationId };
    const state = await this.pdfState(scope, { id: versionId, ...head });
    const { renderedDocumentId } = head;
    if (state !== 'ready' || renderedDocumentId === null) {
      throw state === 'failed' ? pdfFailed() : pdfNotReady();
    }
    return this.documents.issueLinkForOwner(
      scope,
      { ownerType: QUOTATION_OWNER_TYPE, ownerId: versionId },
      renderedDocumentId,
    );
  }

  /**
   * Where the PDF of a visible version stands. Failed: the render was given up, or the newest upload of the rendered
   * document was refused by the scan (infected, scan_failed) or there is none left (removed, or only rejected uploads),
   * since nothing renders a `rendered` version again without the team. Pending: not rendered yet (a failed render with
   * tries left included), or the file awaits its scan. Ready: the newest upload is `clean`. The uploads are read
   * through listForOwner, which has no permission check of its own: this module authorized the caller already.
   */
  private async pdfState(
    scope: TxScope,
    version: {
      id: string;
      renderState: string;
      renderAttempts: number;
      renderedDocumentId: string | null;
    },
  ): Promise<PortalPdfState> {
    if (quotationRenderGivenUp(version)) return 'failed';
    if (version.renderState !== 'rendered' || version.renderedDocumentId === null) return 'pending';
    const versions = await this.documents.listForOwner(scope, QUOTATION_OWNER_TYPE, version.id);
    let newest: (typeof versions)[number] | undefined;
    for (const v of versions) {
      if (v.documentId !== version.renderedDocumentId || v.status === 'rejected') continue;
      if (newest === undefined || v.version > newest.version) newest = v;
    }
    if (newest?.status === 'clean') return 'ready';
    if (newest?.status === 'awaiting_content' || newest?.status === 'quarantined') return 'pending';
    return 'failed';
  }
}

/** The acting entity: the store reads only there, so the version's files and settings live there too. */
const scopeOf = (p: Principal): TxScope => ({
  tenantId: p.tenantId,
  organizationId: p.organizationId,
});

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
  DateFormatSchema,
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  isCustomerVisibleStatus,
  NumberSystemsSchema,
  snapshotNumberSystems,
  type SignedLinkDto,
  PortalQuotationListItemSchema,
  type CustomerQuotationView,
  type PortalDisplay,
  type PortalQuotationListItem,
} from '@bos/contracts';
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { Principal } from '../../platform/authz/principal';
import type { TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsService } from '../../platform/settings/settings.service';
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

const notFound = () => new NotFoundException('Quotation not found');

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

    const { issuerLegalName: _legalName, documentStyle: _documentStyle, ...input } = source;
    try {
      return toCustomerQuotationView(
        {
          ...input,
          issuer,
          display,
          renderedScanClean: await this.renderedScanClean(scope, source.version),
        },
        { purpose: 'portal' },
      );
    } catch (error) {
      if (error instanceof QuotationNotCustomerVisibleError) throw notFound();
      throw error;
    }
  }

  /**
   * How the caller's company writes numbers and dates now, for lists and anything without a frozen snapshot. Any
   * active customer or vendor portal caller; the scope is the caller's acting (selling) entity.
   */
  async display(): Promise<PortalDisplay> {
    const p = this.caller.current();
    assertPortalCaller(p);
    return liveDisplay(this.settings, scopeOf(p));
  }

  /**
   * A short-lived signed link to the frozen PDF of one version. 404 unless the version is the caller's, customer-visible
   * and its rendered document scanned clean; the document module then re-checks the owner and the newest version's scan
   * status itself. DocumentsService.issueLinkForOwner asks no permission (customers hold no `documents.read`, which
   * would also show them draft versions), so this method is the whole authorization: caller, scope, visibility, scan.
   * The link is scoped by the quotation's own tenant and entity (the selling entity), read from its row.
   */
  async quotationPdfLink(versionId: string): Promise<SignedLinkDto> {
    const p = this.caller.current();
    assertCustomerCaller(p);
    const head = await this.store.loadDocumentHead(p, versionId);
    if (head === undefined || !isPortalVisible(head)) throw notFound();
    const scope: TxScope = { tenantId: head.tenantId, organizationId: head.organizationId };
    const { renderedDocumentId } = head;
    if (
      renderedDocumentId === null ||
      !(await this.renderedScanClean(scope, { id: versionId, ...head }))
    ) {
      throw notFound();
    }
    return this.documents.issueLinkForOwner(
      scope,
      { ownerType: QUOTATION_OWNER_TYPE, ownerId: versionId },
      renderedDocumentId,
    );
  }

  /**
   * True when the newest not-rejected version of the rendered document is `clean`. Read through listForOwner,
   * which has no permission check of its own: this module authorized the caller already.
   */
  private async renderedScanClean(
    scope: TxScope,
    version: { id: string; renderState: string; renderedDocumentId: string | null },
  ): Promise<boolean> {
    if (version.renderState !== 'rendered' || version.renderedDocumentId === null) return false;
    const versions = await this.documents.listForOwner(scope, QUOTATION_OWNER_TYPE, version.id);
    let newest: (typeof versions)[number] | undefined;
    for (const v of versions) {
      if (v.documentId !== version.renderedDocumentId || v.status === 'rejected') continue;
      if (newest === undefined || v.version > newest.version) newest = v;
    }
    return newest?.status === 'clean';
  }
}

/** The acting entity: the store reads only there, so the version's files and settings live there too. */
const scopeOf = (p: Principal): TxScope => ({
  tenantId: p.tenantId,
  organizationId: p.organizationId,
});

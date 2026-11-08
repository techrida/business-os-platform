// QuotationPreviewService: the totals and the approval route of a draft version, without saving anything. Serves
// the NFRs:
// - "amounts are exact": the figures are PricingService's, for the lines in the request body, so the workspace never
//   does the maths; the approval facts are the unrounded ones (amountNpr, effectiveDiscountPct);
// - "authorization is deny-by-default" and "one legal entity at a time": the version is read in the acting entity
//   only (another entity's id is a 404, never a 403 that would confirm it exists), and the quotation's owner decides
//   the `own` scope of quotation.draft; a sales user cannot preview a colleague's draft by guessing its id;
// - "no hidden writes": the transaction only reads (the FX rate and tax codes); nothing is inserted or updated.
// The route is dry-run of submit, so it passes the people submit will pass as separation-of-duties users (the
// quotation's owner and the caller) and the blocked flags match what a submit would then find.
import {
  isQuotationEditable,
  type Permission,
  type PreviewResult,
  type QuotationPreviewBody,
} from '@bos/contracts';
import { quotations, quotationVersions, scoped } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AuthzService } from '../../../platform/authz/authz.service';
import { type ResourceRef } from '../../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withTx, type TxScope } from '../../../platform/db/tx';
import { ApprovalsService } from '../../approvals/requests.service';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { PricingService } from '../pricing/pricing.service';
import { QuotationPreviewCaller } from './quotation-preview.caller';
import { approvalFactsOf, previewResultOf, toPricingInput } from './preview-result';

const PREVIEW_ACTION: Permission = 'quotation.draft';

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });

interface VersionHead {
  status: typeof quotationVersions.$inferSelect.status;
  issueDate: string;
  ref: ResourceRef;
}

/** The ResourceRef authz decides on: the quotation's entity, owner and customer. */
export function quotationRef(row: {
  tenantId: string;
  organizationId: string;
  ownerUserId: string | null;
  customerPartyId: string | null;
}): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    customerPartyId: row.customerPartyId,
    sodUserIds: [],
  };
}

@Injectable()
export class QuotationPreviewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly pricing: PricingService,
    private readonly approvals: ApprovalsService,
    private readonly caller: QuotationPreviewCaller,
  ) {}

  async preview(
    quotationId: string,
    versionId: string,
    body: QuotationPreviewBody,
  ): Promise<PreviewResult> {
    const { scope, actor, principal } = this.caller.current();

    const { priced, sodUserIds } = await withTx(this.db, scope, actor, async (tx) => {
      const head = await this.load(tx, scope, quotationId, versionId);
      this.assertVisible(head.ref);
      if (!isQuotationEditable(head.status)) {
        throw new ConflictException({
          code: 'conflict',
          message: `A ${head.status} version cannot be previewed; only a draft or returned version can`,
        });
      }
      const priced = await this.pricing.priceVersion(
        tx,
        scope,
        toPricingInput(body, head.issueDate),
      );
      const people = [head.ref.ownerUserId, principal.userId];
      return {
        priced,
        sodUserIds: [...new Set(people.filter((id): id is string => typeof id === 'string'))],
      };
    });

    // Read after the pricing transaction, on the committed workflow; it writes nothing either.
    const route = await this.approvals.preview(
      scope,
      QUOTATION_OWNER_TYPE,
      approvalFactsOf(priced.facts),
      sodUserIds,
    );
    return previewResultOf(priced, route);
  }

  /** The version with its quotation, in the acting entity only; 404 when it is not there or not that quotation's. */
  private async load(
    tx: DbTransaction,
    scope: TxScope,
    quotationId: string,
    versionId: string,
  ): Promise<VersionHead> {
    const [row] = await tx
      .select({
        status: quotationVersions.status,
        issueDate: quotationVersions.issueDate,
        tenantId: quotationVersions.tenantId,
        organizationId: quotationVersions.organizationId,
        ownerUserId: quotations.ownerUserId,
        customerPartyId: quotations.customerPartyId,
      })
      .from(quotationVersions)
      .innerJoin(
        quotations,
        and(
          eq(quotations.tenantId, quotationVersions.tenantId),
          eq(quotations.organizationId, quotationVersions.organizationId),
          eq(quotations.id, quotationVersions.quotationId),
        ),
      )
      .where(
        scoped(scope).where(
          quotationVersions,
          and(eq(quotationVersions.id, versionId), eq(quotationVersions.quotationId, quotationId)),
        ),
      )
      .limit(1);
    if (row === undefined) throw notFound();
    return { status: row.status, issueDate: row.issueDate, ref: quotationRef(row) };
  }

  /**
   * Record-level authz that answers 404, not 403, for a quotation outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertVisible(ref: ResourceRef): void {
    try {
      this.authz.assert(PREVIEW_ACTION, ref);
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }
}

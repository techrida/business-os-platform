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
import { idpOrgs, quotations, quotationVersions, scoped, userEntities, users } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';

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

/**
 * The ResourceRef authz decides on: the quotation's entity, owner, department and customer. The department is
 * stamped from the opportunity (migration 0088), so a department grant reaches the quotation; a caller that loads
 * a narrow row without it gets no department match (never a wider one). No creator or assignees: every caller
 * checks a write (D55-3).
 */
export function quotationRef(row: {
  tenantId: string;
  organizationId: string;
  ownerUserId: string | null;
  customerPartyId: string | null;
  departmentId?: string | null;
}): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId ?? null,
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
    const facts = approvalFactsOf(priced.facts);
    const route = await this.approvals.preview(scope, QUOTATION_OWNER_TYPE, facts, sodUserIds);
    // Who the author may name for the first step of THIS quotation (never the author or the caller). Not
    // redacted like the route: choosing one is the point. A lookup failure leaves the choice out.
    const choice = await this.approvals
      .assignableApprovers(scope, QUOTATION_OWNER_TYPE, facts, sodUserIds)
      .catch(() => null);
    // ApprovalsService already redacted eligible IDs for requesters who cannot act on approvals.
    const visibleIds = [
      ...new Set([
        ...route.steps.flatMap((step) => step.eligibleUserIds),
        ...(choice?.candidates.map((c) => c.userId) ?? []),
      ]),
    ];
    const staff = await this.staffNames(scope, visibleIds);
    const staffNames = new Map([...staff].map(([id, s]) => [id, s.name]));
    return {
      ...previewResultOf(priced, route),
      route: {
        blocked: route.blocked,
        blockReason: route.blockReason,
        steps: route.steps.map((step) => ({
          seq: step.seq,
          kind: step.kind,
          roleKey: step.roleKey,
          reason: step.reason,
          blocked: step.blocked,
          eligibleUserIds: [],
          eligibleStaffNames: step.eligibleUserIds.flatMap((id) => {
            const name = staffNames.get(id);
            return name ? [name] : [];
          }),
        })),
      },
      approverChoice:
        choice === null
          ? null
          : {
              seq: choice.seq,
              options: choice.candidates.flatMap((c) => {
                const person = staff.get(c.userId);
                return person
                  ? [
                      {
                        userId: c.userId,
                        name: person.name,
                        roleKey: c.roleKey,
                        hasEmail: person.hasEmail,
                      },
                    ]
                  : [];
              }),
            },
    };
  }

  /**
   * Match the workflow's active-staff and entity checks when resolving display names. A person without a display
   * name is shown by the part of their address before the @; one with neither is left out. `hasEmail` only says
   * whether an address exists, never what it is.
   */
  private async staffNames(
    scope: TxScope,
    ids: string[],
  ): Promise<ReadonlyMap<string, { name: string; hasEmail: boolean }>> {
    const names = new Map<string, { name: string; hasEmail: boolean }>();
    if (ids.length === 0) return names;
    try {
      const rows = await this.db
        .select({ id: users.id, name: users.displayName, email: users.email })
        .from(userEntities)
        .innerJoin(
          users,
          and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
        )
        .innerJoin(
          idpOrgs,
          and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)),
        )
        .where(
          and(
            scoped(scope).where(userEntities),
            eq(users.status, 'active'),
            eq(idpOrgs.kind, 'staff'),
            inArray(users.id, ids),
          ),
        );
      for (const row of rows) {
        const email = row.email?.trim() ?? '';
        // A blank name reads 'Unnamed user', never a piece of the address (D54-2).
        const name = row.name?.trim() || 'Unnamed user';
        names.set(row.id, { name, hasEmail: email !== '' });
      }
    } catch {
      // Names are optional. A directory lookup failure should still return pricing and route status.
    }
    return names;
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
        departmentId: quotations.departmentId,
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

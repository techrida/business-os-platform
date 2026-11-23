import { randomUUID } from 'node:crypto';

import { isQuotationEditable, type CustomerDto, type OpportunityDto } from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { addContactAction } from '@/components/p2/customers/actions';
import * as api from '@/components/p2/quote-builder/api';
import { getQuotation } from '@/components/p2/quotations/api';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { ContextCard } from '@/components/p2/quote-builder/context-card';
import { describeQuoteFailure } from '@/components/p2/quote-builder/failure';
import { LoadFailure } from '@/components/p2/quote-builder/load-failure';
import { loadLookups } from '@/components/p2/quote-builder/lookups';
import { valuesFromVersion } from '@/components/p2/quote-builder/model';
import { QuoteBuilder } from '@/components/p2/quote-builder/quote-builder';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

export const metadata: Metadata = { title: 'Edit quotation · Business OS' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ saved?: string | string[]; submitted?: string | string[] }>;

export default async function EditQuotationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const path = `/quotations/${encodeURIComponent(id)}/edit`;
  const session = await requireStaffSession(path);
  const query = await searchParams;

  let detail;
  try {
    // `GET /v1/quotations/:id` answers the parent with every version, so one call is enough.
    detail = await getQuotation(session, id);
  } catch (err) {
    if (describeQuoteFailure(err, 'load').kind === 'not_found') notFound();
    return <LoadFailure err={err} title="Edit quotation" retryHref={path} />;
  }
  const { quotation } = detail;
  const version = detail.versions.find((v) => v.id === quotation.currentVersionId);
  if (version === undefined) {
    // Never fall back to another revision: editing the wrong one would be worse than stopping.
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[{ label: 'Quotations', href: '/quotations' }, { label: quotation.number }]}
        />
        <PageHeader title={quotation.number} />
        <Alert
          tone="warning"
          role="alert"
          title="The current revision is missing from this answer."
          actions={
            <LinkButton href={path} variant="secondary">
              Reload
            </LinkButton>
          }
        >
          The platform did not send the revision this quotation says is current, so it cannot be
          edited right now. Reload to try again.
        </Alert>
      </Page>
    );
  }

  const title = `${version.number} Rev ${version.revisionNo}`;
  const crumbs = [{ label: 'Quotations', href: '/quotations' }, { label: title }];

  // Only Draft and Returned versions can change; every later change is a revision.
  if (!isQuotationEditable(version.status)) {
    const justSubmitted = query.submitted === '1' && version.status === 'submitted';
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <PageHeader
          title={title}
          status={
            <QuotationStatusBadge
              status={version.status}
              rejectionSource={version.rejectionSource}
            />
          }
        />
        <Alert
          tone="info"
          role="status"
          title={justSubmitted ? 'Approval pending' : 'This version can no longer be edited'}
          actions={
            <LinkButton href="/quotations" variant="secondary">
              Back to quotations
            </LinkButton>
          }
        >
          {justSubmitted
            ? 'You will get a notification when it is decided. If the approver returns it, you can change it and submit again.'
            : 'Only a draft or a returned quotation can be edited. To change this one, revise it, which starts a new draft.'}
        </Alert>
      </Page>
    );
  }

  // Editable, but not by this caller (a colleague's quotation, or a role that cannot draft): the
  // server would refuse the save with 403, so the editor is not offered at all.
  if (!detail.capabilities.canEdit) {
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <PageHeader
          title={title}
          status={
            <QuotationStatusBadge
              status={version.status}
              rejectionSource={version.rejectionSource}
            />
          }
        />
        <Alert
          tone="info"
          role="status"
          title="You can view this quotation but not edit it"
          actions={
            <LinkButton
              href={`/quotations/${encodeURIComponent(quotation.id)}`}
              variant="secondary"
            >
              Open the quotation
            </LinkButton>
          }
        >
          Only its owner, or someone whose role allows editing it, can change this draft.
        </Alert>
      </Page>
    );
  }

  const mayAddContact = (await getPermissionCheck(session))('customer.write');
  const [customer, opportunity, lookups, enabledCurrencies] = await Promise.all([
    api.getCustomer(session, quotation.customerId).then(
      (c): CustomerDto | null => c,
      (): CustomerDto | null => null,
    ),
    api.getOpportunity(session, quotation.opportunityId).then(
      (o): OpportunityDto | null => o,
      (): OpportunityDto | null => null,
    ),
    loadLookups(session, quotation.customerId),
    loadEnabledCurrencies(session),
  ]);

  return (
    <Page>
      <Breadcrumb items={crumbs} />
      <QuoteBuilder
        title={title}
        status={
          <QuotationStatusBadge status={version.status} rejectionSource={version.rejectionSource} />
        }
        description="Save the draft, then submit it for approval."
        cancelHref={`/quotations/${encodeURIComponent(quotation.id)}`}
        target={{
          mode: 'edit',
          quotationId: quotation.id,
          versionId: version.id,
          expectedVersion: version.version,
        }}
        initial={valuesFromVersion(version)}
        context={<ContextCard customer={customer} opportunity={opportunity} />}
        contacts={lookups.contacts}
        createContact={
          mayAddContact
            ? {
                action: addContactAction,
                customerId: quotation.customerId,
                ...(customer ? { customerCountry: customer.country } : {}),
              }
            : null
        }
        taxCodes={lookups.taxCodes}
        paymentTerms={lookups.paymentTerms}
        termPresets={lookups.termPresets}
        canAddTerms={lookups.canAddTerms}
        enabledCurrencies={enabledCurrencies}
        idempotencyKey={randomUUID()}
        savedNotice={query.saved === '1'}
      />
    </Page>
  );
}

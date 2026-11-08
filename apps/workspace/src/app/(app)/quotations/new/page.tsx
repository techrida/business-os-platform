import { randomUUID } from 'node:crypto';

import type { CustomerDto, OpportunityDto } from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ContextCard } from '@/components/p2/quote-builder/context-card';
import { LoadFailure } from '@/components/p2/quote-builder/load-failure';
import { loadLookups } from '@/components/p2/quote-builder/lookups';
import { defaultDates, emptyValues } from '@/components/p2/quote-builder/model';
import { QuoteBuilder } from '@/components/p2/quote-builder/quote-builder';
import * as api from '@/components/p2/quote-builder/api';
import { describeQuoteFailure } from '@/components/p2/quote-builder/failure';
import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';

export const metadata: Metadata = { title: 'New quotation · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string | string[] }>;
}) {
  const query = await searchParams;
  const raw = Array.isArray(query.opportunityId) ? query.opportunityId[0] : query.opportunityId;
  const opportunityId = raw !== undefined && UUID.test(raw) ? raw : null;
  const path =
    opportunityId !== null
      ? `/quotations/new?opportunityId=${encodeURIComponent(opportunityId)}`
      : '/quotations/new';
  const session = await requireStaffSession(path);

  if (opportunityId === null) {
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[{ label: 'Quotations', href: '/quotations' }, { label: 'New quotation' }]}
        />
        <PageHeader title="New quotation" />
        <EmptyState
          title="Start from an opportunity"
          icon="file-text"
          action={<LinkButton href="/opportunities">Go to opportunities</LinkButton>}
        >
          A quotation is written for an opportunity, so the customer and contact come with it. Open
          the opportunity and choose New quotation.
        </EmptyState>
      </Page>
    );
  }

  let opportunity: OpportunityDto;
  try {
    opportunity = await api.getOpportunity(session, opportunityId);
  } catch (err) {
    if (describeQuoteFailure(err, 'load').kind === 'not_found') notFound();
    return <LoadFailure err={err} title="New quotation" retryHref={path} />;
  }

  const [customerResult, lookups] = await Promise.all([
    api.getCustomer(session, opportunity.customerId).then(
      (c): CustomerDto | null => c,
      (): CustomerDto | null => null,
    ),
    loadLookups(session, opportunity.customerId),
  ]);

  const currency = customerResult?.defaultCurrency ?? opportunity.currency;
  const initial = emptyValues({ currency, ...defaultDates() });
  initial.contactId = opportunity.contactId ?? '';

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'New quotation' }]}
      />
      <PageHeader
        title="New quotation"
        description="Save a draft first. The platform then works out the totals and who must approve."
      />
      <QuoteBuilder
        target={{ mode: 'create', opportunityId }}
        initial={initial}
        context={<ContextCard customer={customerResult} opportunity={opportunity} />}
        contacts={lookups.contacts}
        taxCodes={lookups.taxCodes}
        paymentTerms={lookups.paymentTerms}
        idempotencyKey={randomUUID()}
      />
    </Page>
  );
}

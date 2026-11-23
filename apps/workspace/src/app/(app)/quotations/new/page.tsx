import { randomUUID } from 'node:crypto';

import type { CustomerDto, OpportunityDto } from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { addContactAction } from '@/components/p2/customers/actions';
import { ContextCard } from '@/components/p2/quote-builder/context-card';
import { LoadFailure } from '@/components/p2/quote-builder/load-failure';
import { loadLookups } from '@/components/p2/quote-builder/lookups';
import { withDefaultTerms } from '@/components/p2/quote-builder/saved-options';
import { defaultDates, emptyValues } from '@/components/p2/quote-builder/model';
import { QuoteBuilder } from '@/components/p2/quote-builder/quote-builder';
import * as api from '@/components/p2/quote-builder/api';
import { describeQuoteFailure } from '@/components/p2/quote-builder/failure';
import { listQuotations } from '@/components/p2/quotations/api';
import {
  editQuotationHref,
  newQuotationHref,
  opportunityQuotationsHref,
  quotationEntryFor,
  type QuotationEntry,
} from '@/components/p2/quotations/resume';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

export const metadata: Metadata = { title: 'New quotation · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string | string[]; another?: string | string[] }>;
}) {
  const query = await searchParams;
  const raw = first(query.opportunityId);
  const opportunityId = raw !== undefined && UUID.test(raw) ? raw : null;
  // "Start another quotation", chosen on the opportunity's list: the person has seen the drafts.
  const another = first(query.another) === '1';
  const path =
    opportunityId !== null ? newQuotationHref(opportunityId, { another }) : '/quotations/new';
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

  // A draft already saved for this opportunity is resumed, never duplicated: one editable quotation
  // opens in its editor, several go to the opportunity's list to choose. A list that does not load
  // does not block a new quotation (the person may simply have none to read).
  const entry: QuotationEntry = await listQuotations(session, { opportunityId }).then(
    quotationEntryFor,
    (): QuotationEntry => ({ kind: 'new' }),
  );
  if (!another) {
    if (entry.kind === 'resume') redirect(editQuotationHref(entry.quotationId));
    if (entry.kind === 'choose') redirect(opportunityQuotationsHref(opportunityId));
  }

  const mayAddContact = (await getPermissionCheck(session))('customer.write');
  const [customerResult, lookups, enabledCurrencies] = await Promise.all([
    api.getCustomer(session, opportunity.customerId).then(
      (c): CustomerDto | null => c,
      (): CustomerDto | null => null,
    ),
    loadLookups(session, opportunity.customerId),
    loadEnabledCurrencies(session),
  ]);

  // The customer's or opportunity's currency, as it is, even when the company has since switched it
  // off (U16-Q7, D44): the builder then shows it as not enabled and refuses to save until another is
  // chosen. A money document never changes currency without the person seeing it.
  const currency = customerResult?.defaultCurrency ?? opportunity.currency;
  const initial = emptyValues({ currency, ...defaultDates() });
  initial.contactId = opportunity.contactId ?? '';
  // Each terms field starts with the default saved option chosen in settings, if there is one.
  const startValues = withDefaultTerms(initial, lookups.termPresets);

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'New quotation' }]}
      />
      <QuoteBuilder
        target={{ mode: 'create', opportunityId }}
        title="New quotation"
        description="Prepare and save a draft to calculate totals and see the approval route."
        cancelHref={`/opportunities/${encodeURIComponent(opportunityId)}`}
        notice={
          entry.kind !== 'new' ? (
            <Alert
              tone="info"
              role="status"
              title="This opportunity already has a draft"
              actions={
                entry.kind === 'resume' ? (
                  <LinkButton href={editQuotationHref(entry.quotationId)} variant="secondary">
                    Edit {entry.number}
                  </LinkButton>
                ) : (
                  <LinkButton href={opportunityQuotationsHref(opportunityId)} variant="secondary">
                    View its quotations
                  </LinkButton>
                )
              }
            >
              Saving here starts another, separate quotation.
            </Alert>
          ) : null
        }
        initial={startValues}
        context={<ContextCard customer={customerResult} opportunity={opportunity} />}
        contacts={lookups.contacts}
        createContact={
          mayAddContact
            ? {
                action: addContactAction,
                customerId: opportunity.customerId,
                ...(customerResult ? { customerCountry: customerResult.country } : {}),
              }
            : null
        }
        taxCodes={lookups.taxCodes}
        paymentTerms={lookups.paymentTerms}
        termPresets={lookups.termPresets}
        canAddTerms={lookups.canAddTerms}
        enabledCurrencies={enabledCurrencies}
        idempotencyKey={randomUUID()}
      />
    </Page>
  );
}

import type { CustomerDto, OpportunityDto } from '@bos/contracts';

import { Alert } from '@/components/ui/alert';
import { FactList, type Fact } from '@/components/ui/panel';

/**
 * Section 1's read-only facts: the customer and the opportunity this quotation is for. Either may
 * be missing when its lookup failed; the page says so and the quotation can still be saved,
 * because the customer is taken from the opportunity on the server.
 */
export function ContextCard({
  customer,
  opportunity,
}: {
  customer: CustomerDto | null;
  opportunity: OpportunityDto | null;
}) {
  const facts: Fact[] = [
    {
      key: 'customer',
      label: 'Customer',
      value: customer ? `${customer.legalName} (${customer.number})` : 'Not available',
    },
    {
      key: 'opportunity',
      label: 'Opportunity',
      value: opportunity ? `${opportunity.number} · ${opportunity.name}` : 'Not available',
    },
    ...(customer?.industry
      ? [{ key: 'industry', label: 'Industry', value: customer.industry }]
      : []),
    ...(customer?.panVatNo ? [{ key: 'pan', label: 'PAN / VAT', value: customer.panVatNo }] : []),
  ];
  return (
    <>
      {!customer || !opportunity ? (
        <Alert tone="warning" role="status">
          Some customer or opportunity details did not load. You can keep working; they are not
          needed to save the quotation.
        </Alert>
      ) : null}
      <FactList facts={facts} />
    </>
  );
}

import type { CustomerDto, OpportunityDto } from '@bos/contracts';

import { companyLogo } from '@/app/(app)/customers/_lib/company-logo';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { FactList, type Fact } from '@/components/ui/panel';

import styles from './quote-builder.module.css';

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
      <div className={styles.identity}>
        <Avatar
          {...(customer
            ? companyLogo(customer)
            : { name: '', shape: 'square' as const, fit: 'contain' as const })}
          size="large"
          className={styles.customerAvatar}
        />
        <div>
          <h2>{customer?.legalName ?? 'Customer details unavailable'}</h2>
          {customer ? <span className={styles.muted}>{customer.number}</span> : null}
        </div>
      </div>
      <FactList facts={facts} className={styles.contextFacts ?? ''} />
    </>
  );
}

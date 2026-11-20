import type { CustomerQuotationView, EvidenceKind } from '@bos/contracts';

import { Alert } from './alert';

type AfterAcceptance = NonNullable<CustomerQuotationView['afterAcceptance']>;

/** The document each evidence kind is, in the customer's words. */
const DOCUMENT: Record<EvidenceKind, string> = {
  contract: 'a signed contract',
  purchase_order: 'a purchase order',
  signed_quote: 'a signed copy of this quotation',
};

/** "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * What the customer waits for after accepting (F1-Q28): staff confirm the acceptance, and when the company needs a
 * signed contract or a purchase order, the customer is told which, so an acceptance never ends in "contact us".
 */
export function nextStepText(after: AfterAcceptance): { title: string; body: string } {
  if (after.status === 'confirmed') {
    return {
      title: 'Acceptance confirmed',
      body: 'We have everything we need. Our team will be in touch about delivery and billing.',
    };
  }
  if (after.needs.length === 0) {
    return {
      title: 'What happens next',
      body: 'Our team will confirm your acceptance and then send you the order details.',
    };
  }
  return {
    title: 'What happens next',
    body: `To complete your order we need ${listed(after.needs.map((k) => DOCUMENT[k]))} from you. Our team will contact you to collect it, then confirm your acceptance.`,
  };
}

export function QuotationNextStep({
  after,
  className,
}: {
  after: AfterAcceptance;
  className?: string | undefined;
}) {
  const { title, body } = nextStepText(after);
  return (
    <Alert
      tone={after.status === 'confirmed' ? 'success' : 'info'}
      title={title}
      className={className}
    >
      {body}
    </Alert>
  );
}

import { QUOTATION_STATUSES, type QuotationSummary } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { statusWorth } from './summary-amount';

function summary(amounts?: Partial<Record<string, { currency: 'NPR' | 'USD'; total: string }[]>>) {
  const byStatus = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, 0]));
  const empty = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, []]));
  return {
    total: 0,
    byStatus,
    ...(amounts !== undefined ? { amounts: { ...empty, ...amounts } } : {}),
  } as QuotationSummary;
}

describe('statusWorth', () => {
  it('gives the single currency and its sum', () => {
    const s = summary({ submitted: [{ currency: 'NPR', total: '245000.00' }] });
    expect(statusWorth(s, 'submitted')).toEqual({ currency: 'NPR', total: '245000.00' });
  });

  it('gives nothing for mixed currencies, rather than adding unlike money', () => {
    const s = summary({
      sent: [
        { currency: 'NPR', total: '100.00' },
        { currency: 'USD', total: '50.00' },
      ],
    });
    expect(statusWorth(s, 'sent')).toBeNull();
  });

  it('gives nothing for no quotations, a zero sum, or an API that sends no amounts', () => {
    expect(statusWorth(summary({}), 'accepted')).toBeNull();
    expect(
      statusWorth(summary({ accepted: [{ currency: 'NPR', total: '0.00' }] }), 'accepted'),
    ).toBeNull();
    expect(statusWorth(summary(), 'accepted')).toBeNull();
  });
});

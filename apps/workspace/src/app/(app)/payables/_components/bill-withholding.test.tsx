import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../actions', () => ({ convertSubmissionAction: vi.fn(), createBillAction: vi.fn() }));
import { BillEntryForm } from './bill-entry-form';

describe('bill withholding selection', () => {
  it('offers named withholding codes and an explicit no-withholding option while retaining the account GUID field', () => {
    const out = renderToStaticMarkup(
      <BillEntryForm
        idempotencyKey="key"
        orderLines={[]}
        taxCodes={[]}
        withholdingCodes={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            label: 'TDS0 - Pending accountant signoff',
          },
        ]}
        cancelHref="/payables/bills"
        reloadHref="/payables/bills/new"
      />,
    );
    expect(out).toMatch(/<select[^>]*name="line:0:tdsCodeId"/);
    expect(out).toContain('TDS0 - Pending accountant signoff');
    expect(out).toContain('No withholding');
    expect(out).toContain('name="line:0:accountId"');
    expect(out).not.toContain('Withholding code ID');
  });
});

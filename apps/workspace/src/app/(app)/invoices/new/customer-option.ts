import type { Currency, CustomerDto } from '@bos/contracts';

/** One customer the invoice can be raised for. */
export interface CustomerOption {
  id: string;
  /** The customer's legal name. */
  label: string;
  /** The number and PAN/VAT shown under the name in the picker, so a search by either finds the customer. */
  detail?: string | undefined;
  /** The customer's usual currency: it preselects the currency when the customer is chosen. */
  currency: Currency | null;
}

/** The page's list and the picker's search route answer with the same shape. */
export const toCustomerOption = (c: CustomerDto): CustomerOption => ({
  id: c.id,
  label: c.legalName,
  detail: [c.number, c.panVatNo].filter(Boolean).join(' · '),
  currency: c.defaultCurrency,
});

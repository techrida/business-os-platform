import type { Currency, CustomerDto } from '@bos/contracts';

/** One customer the person can choose. Names, numbers and PAN/VAT only: the form shows no balances. */
export interface CustomerOption {
  id: string;
  name: string;
  number: string;
  /** The customer's PAN or VAT number, shown beside the number so either finds the customer. */
  panVatNo?: string | null | undefined;
  /** The customer's usual currency, used as the starting choice. */
  defaultCurrency: Currency | null;
}

export const toCustomerOption = (c: CustomerDto): CustomerOption => ({
  id: c.id,
  name: c.legalName,
  number: c.number,
  panVatNo: c.panVatNo,
  defaultCurrency: c.defaultCurrency,
});

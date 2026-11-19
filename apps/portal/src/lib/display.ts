import type { PortalDisplay } from '@bos/contracts';
import {
  type Currency,
  DEFAULT_CUSTOMER_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  formatCustomerDate,
  formatMoney,
} from '@bos/locale';

/**
 * How the selling company writes numbers and dates (D30, D27). Server and client safe: the portal
 * reads it from the API once per request (`getPortalDisplay`) and hands it to the views as a prop,
 * so every amount and date on a page uses the same setting. A view built without one draws the
 * defaults: lakh grouping for NPR and INR, international for USD, and `23 Nov 2026` dates.
 */
export const DEFAULT_PORTAL_DISPLAY: PortalDisplay = {
  numberSystems: DEFAULT_NUMBER_SYSTEMS,
  dateFormat: DEFAULT_CUSTOMER_DATE_FORMAT,
};

/** The two formatters a view needs, bound to one display setting. */
export function displayFormat(display: PortalDisplay = DEFAULT_PORTAL_DISPLAY) {
  return {
    money: (amount: string, currency: Currency): string =>
      formatMoney(amount, currency, { numberSystems: display.numberSystems }),
    day: (value: string): string => formatCustomerDate(value, display.dateFormat),
  };
}

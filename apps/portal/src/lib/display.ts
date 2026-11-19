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

/**
 * A tax line's label with its rate. The label is the tax code's own name and usually already carries the rate
 * ("VAT 13%"), so the rate is added only when the label does not show it.
 */
export function taxLineLabel(label: string, percent: string): string {
  const rate = percent.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  // A whole percent token only: "VAT 13%" shows 13%, but it does not show 3%.
  const shown = new RegExp(`(^|[^\\d.])${rate.replace('.', '\\.')}%`).test(label);
  return shown ? label : `${label} ${rate}%`;
}

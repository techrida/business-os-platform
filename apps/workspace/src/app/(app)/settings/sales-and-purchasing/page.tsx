import { redirectToSectionStart } from '../_components/section-index';

export default async function SalesAndPurchasingSectionPage(): Promise<void> {
  await redirectToSectionStart('sales-and-purchasing');
}

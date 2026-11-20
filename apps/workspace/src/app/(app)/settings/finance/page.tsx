import { redirectToSectionStart } from '../_components/section-index';

export default async function FinanceSectionPage(): Promise<void> {
  await redirectToSectionStart('finance');
}

import { redirectToSectionStart } from '../_components/section-index';

export default async function CompanySetupSectionPage(): Promise<void> {
  await redirectToSectionStart('company-setup');
}

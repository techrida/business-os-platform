import { redirectToSectionStart } from '../_components/section-index';

export default async function OrganisationSectionPage(): Promise<void> {
  await redirectToSectionStart('organisation');
}

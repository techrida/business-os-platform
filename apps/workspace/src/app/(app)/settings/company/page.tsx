import type { Metadata } from 'next';

import { CompanyEditor } from '@/components/settings/company-editor';
import { parseCompanySettings } from '@/components/settings/company-profile';
import { Page, PageHeader } from '@/components/ui/page';
import { getSetting } from '@/lib/api-admin';

import { BackToSettings } from '../_components/back-link';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { saveCompanyCardAction } from './actions';

export const metadata: Metadata = { title: 'Company profile · Business OS' };

export default async function CompanySettingsPage() {
  const session = await requireSection('company');
  // The profile, the address and the PAN or VAT number are three settings; one failed read (for
  // example a 403) gives one notice and no half-filled form.
  const loaded = await section('view the company profile', async () => {
    const [profile, address, panVatNo] = await Promise.all([
      getSetting(session, 'entity.profile'),
      getSetting(session, 'entity.address'),
      getSetting(session, 'entity.pan_vat_no'),
    ]);
    return parseCompanySettings({
      profile: profile.value,
      address: address.value,
      panVatNo: panVatNo.value,
    });
  });

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Company profile"
        description="Who you are on every document. Every change is recorded in the audit trail."
      />
      {!loaded.ok ? (
        <SectionError message={loaded.message} />
      ) : !loaded.data.ok ? (
        <SectionError message={loaded.data.message} />
      ) : (
        <CompanyEditor settings={loaded.data.data} action={saveCompanyCardAction} />
      )}
    </Page>
  );
}

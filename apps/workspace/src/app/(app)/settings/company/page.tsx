import type { Metadata } from 'next';

import { CompanyEditor } from '@/components/settings/company-editor';
import { parseCompanySettings, type CompanyVersions } from '@/components/settings/company-profile';
import { loadedVersion } from '@/components/settings/stale-setting';
import { Page, PageHeader } from '@/components/ui/page';
import { getSetting } from '@/lib/api-admin';

import { BackToSettings } from '../_components/back-link';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { resetCompanyCardAction, saveCompanyCardAction } from './actions';

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
    // The version each setting had when this screen loaded travels with every save, so a save
    // made after someone else's change is refused instead of overwriting it.
    const versions: CompanyVersions = {
      'entity.profile': loadedVersion(profile.version),
      'entity.address': loadedVersion(address.version),
      'entity.pan_vat_no': loadedVersion(panVatNo.version),
    };
    return {
      versions,
      settings: parseCompanySettings({
        profile: profile.value,
        address: address.value,
        panVatNo: panVatNo.value,
      }),
    };
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
      ) : !loaded.data.settings.ok ? (
        <SectionError message={loaded.data.settings.message} />
      ) : (
        <CompanyEditor
          settings={loaded.data.settings.data}
          versions={loaded.data.versions}
          action={saveCompanyCardAction}
          resetCard={resetCompanyCardAction}
        />
      )}
    </Page>
  );
}

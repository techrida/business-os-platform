import type { Metadata } from 'next';

import { TermPresetsManager } from '@/components/settings/term-presets/term-presets-manager';
import { Page, PageHeader } from '@/components/ui/page';
import { listTermPresets } from '@/lib/api-term-presets';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';

export const metadata: Metadata = { title: 'Saved terms · Business OS' };

export default async function TermsSettingsPage() {
  const session = await requireSection('terms');
  const presets = await section('view saved terms', () => listTermPresets(session));

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Saved terms"
        description="Ready-made wording for quotation fields. Staff pick an option to fill a field, then edit it freely. A quotation keeps its own text, so changing an option never changes a quotation already written."
      />
      <div className={`${styles.column} ${styles.narrow}`}>
        {presets.ok ? (
          <TermPresetsManager presets={presets.data} />
        ) : (
          <SectionError message={presets.message} />
        )}
      </div>
    </Page>
  );
}

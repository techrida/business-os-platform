import { DEFAULT_TERM_PRESETS } from '@bos/contracts';
import type { Metadata } from 'next';

import { ResetToDefaultButton } from '@/components/settings/reset-to-default';
import { termSetsAreDefault } from '@/components/settings/term-presets/term-preset-model';
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
  const presets = await section('view term sets', () => listTermPresets(session));

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Saved terms"
        description="Ready-made wording for quotation fields. Staff pick a term set to fill a field, then edit it freely. A quotation keeps its own text, so changing a set never changes a quotation already written."
        actions={
          presets.ok ? (
            <ResetToDefaultButton
              section="terms"
              settingKey="quotation.term_presets"
              label="all term sets"
              isDefault={termSetsAreDefault(presets.data)}
              defaultText={`the ${DEFAULT_TERM_PRESETS.length} app default sets`}
              confirm={{
                title: 'Reset all term sets to default?',
                body: `Your own term sets are removed, your changes to the app's sets are undone, and the ${DEFAULT_TERM_PRESETS.length} default sets come back. Quotations already written keep their text.`,
                confirmLabel: 'Reset term sets',
              }}
            />
          ) : null
        }
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

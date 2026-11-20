import { DEFAULT_TERM_PRESETS } from '@bos/contracts';
import type { Metadata } from 'next';

import { ResetToDefaultButton } from '@/components/settings/reset-to-default';
import { termSetsAreDefault } from '@/components/settings/term-presets/term-preset-model';
import { TermPresetsManager } from '@/components/settings/term-presets/term-presets-manager';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { getSetting } from '@/lib/api-admin';
import { listAdminPaymentTerms } from '@/lib/api-master-data';
import { listTermPresets } from '@/lib/api-term-presets';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { PaymentTermsPanel } from './payment-terms-panel';

export const metadata: Metadata = { title: 'Saved terms · Business OS' };

export default async function TermsSettingsPage() {
  const session = await requireSection('terms');
  // Read first, so a change made between the two reads makes the reset refuse rather than overwrite it.
  const saved = await section('view term sets', () =>
    getSetting(session, 'quotation.term_presets'),
  );
  const [presets, paymentTerms] = await Promise.all([
    section('view term sets', () => listTermPresets(session)),
    section('view payment terms', () => listAdminPaymentTerms(session)),
  ]);

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Saved terms"
        description="Ready-made wording for quotation fields, and the payment terms documents use. Staff pick a term set to fill a field, then edit it freely. A quotation keeps its own text, so changing a set never changes a quotation already written."
        actions={
          presets.ok && saved.ok ? (
            <ResetToDefaultButton
              section="terms"
              settingKey="quotation.term_presets"
              label="all term sets"
              isDefault={termSetsAreDefault(presets.data)}
              loadedVersion={saved.data.version}
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
        <Panel
          title="Payment terms"
          description="When an invoice or bill is due: the named terms documents and accounts can use."
        >
          {paymentTerms.ok ? (
            <PaymentTermsPanel terms={paymentTerms.data} />
          ) : (
            <SectionError message={paymentTerms.message} />
          )}
        </Panel>
      </div>
    </Page>
  );
}

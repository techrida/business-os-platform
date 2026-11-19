import { NUMBER_SYSTEM_VALUES } from '@bos/contracts';
import type { Metadata } from 'next';

import { NumberSystemCard } from '@/components/settings/number-system-card';
import { parseNumberSystem } from '@/components/settings/number-format';
import { Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel } from '@/components/ui/panel';
import { getSetting } from '@/lib/api-admin';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { saveNumberSystemAction } from './actions';

export const metadata: Metadata = { title: 'Number and date format · Business OS' };

// Fixed for every document today; there is no setting for them, so they are text, not controls.
const FIXED_FACTS = [
  { key: 'tz', label: 'Time zone', value: 'Asia/Kathmandu' },
  { key: 'money', label: 'Money', value: 'Shown to 2 decimal places, rounded half up' },
] as const;

export default async function FormatsSettingsPage() {
  const session = await requireSection('formats');
  const loaded = await section('view the number format', async () => {
    const current = await getSetting(session, 'format.number_system');
    // A stored value this screen cannot read falls back to the built-in default, as the API does.
    return parseNumberSystem(current.value) ?? NUMBER_SYSTEM_VALUES[0];
  });

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Number and date format"
        description="How amounts are grouped and spelled out. Every change is recorded in the audit trail."
      />
      <div className={`${styles.column} ${styles.narrow}`}>
        {loaded.ok ? (
          <NumberSystemCard current={loaded.data} action={saveNumberSystemAction} />
        ) : (
          <SectionError message={loaded.message} />
        )}
        <Panel title="Always the same" description="These are not settings.">
          <FactList facts={FIXED_FACTS} />
        </Panel>
      </div>
    </Page>
  );
}

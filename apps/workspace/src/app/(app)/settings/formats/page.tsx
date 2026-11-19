import { DEFAULT_DATE_FORMAT, DEFAULT_NUMBER_SYSTEMS } from '@bos/contracts';
import type { Metadata } from 'next';

import { DateFormatCard } from '@/components/settings/date-format-card';
import {
  parseDateFormat,
  parseNumberSystems,
  todayInKathmandu,
} from '@/components/settings/number-format';
import { NumberSystemCard } from '@/components/settings/number-system-card';
import { loadedVersion } from '@/components/settings/stale-setting';
import { Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel } from '@/components/ui/panel';
import { getSetting } from '@/lib/api-admin';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import {
  resetDateFormatAction,
  resetNumberSystemAction,
  saveDateFormatAction,
  saveNumberSystemsAction,
} from './actions';

export const metadata: Metadata = { title: 'Number and date format · Business OS' };

// Fixed for every document today; there is no setting for them, so they are text, not controls.
const FIXED_FACTS = [
  { key: 'tz', label: 'Time zone', value: 'Asia/Kathmandu' },
  { key: 'money', label: 'Money', value: 'Shown to 2 decimal places, rounded half up' },
] as const;

export default async function FormatsSettingsPage() {
  const session = await requireSection('formats');
  // Each setting loads on its own, so one the admin may not read does not hide the other card.
  const numbers = await section('view the number format', async () => {
    const current = await getSetting(session, 'format.number_systems');
    // A stored value this screen cannot read falls back to the built-in default, as the API does.
    // The version still comes from what was loaded, so a save is checked against it.
    return {
      saved: parseNumberSystems(current.value) ?? DEFAULT_NUMBER_SYSTEMS,
      version: loadedVersion(current.version),
    };
  });
  const date = await section('view the date format', async () => {
    const current = await getSetting(session, 'format.date');
    return {
      saved: parseDateFormat(current.value) ?? DEFAULT_DATE_FORMAT,
      version: loadedVersion(current.version),
    };
  });
  // Worked out once here, so the examples read the same on the server and in the browser.
  const today = todayInKathmandu();

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Number and date format"
        description="How amounts are grouped and spelled out, and how dates are written on documents."
      />
      <div className={`${styles.column} ${styles.narrow}`}>
        {numbers.ok ? (
          <NumberSystemCard
            saved={numbers.data.saved}
            version={numbers.data.version}
            saveAction={saveNumberSystemsAction}
            resetAction={resetNumberSystemAction}
          />
        ) : (
          <SectionError message={numbers.message} />
        )}
        {date.ok ? (
          <DateFormatCard
            saved={date.data.saved}
            version={date.data.version}
            today={today}
            saveAction={saveDateFormatAction}
            resetAction={resetDateFormatAction}
          />
        ) : (
          <SectionError message={date.message} />
        )}
        <Panel title="Always the same" description="These are not settings.">
          <FactList facts={FIXED_FACTS} />
        </Panel>
      </div>
    </Page>
  );
}

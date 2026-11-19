'use client';

import type { DateFormatSetting } from '@bos/contracts';
import { useActionState, useMemo, useState } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import { Field, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';

import styles from './date-format-card.module.css';
import { FormatCardFoot, isStaleState, useStaleVersion } from './format-card-foot';
import {
  dateFormatOptions,
  defaultDateFormatText,
  isDefaultDateFormat,
  parseDateFormat,
  parseVersionField,
} from './number-format';
import { ResetToDefaultButton } from './reset-to-default';

/**
 * How dates are written on documents. One select, each option shown as today's date in that
 * pattern, and an undo icon while the saved format is not the default (D27, D32). `today` is
 * worked out once on the server (Kathmandu), so the examples cannot differ between server and
 * browser. An unsaved choice is an override over the saved value, so a refresh keeps it.
 */
export function DateFormatCard({
  saved,
  version,
  today,
  saveAction,
  resetAction,
}: {
  saved: DateFormatSetting;
  /** The version the page loaded (null when it loaded the default). */
  version: number | null;
  /** Today in Kathmandu as `YYYY-MM-DD`. */
  today: string;
  saveAction: (previous: ActionState, formData: FormData) => Promise<ActionState>;
  resetAction: (loadedVersion: number | null) => Promise<ActionState>;
}) {
  const [draft, setDraft] = useState<DateFormatSetting | null>(null);
  const { stale, markStale, clearStale } = useStaleVersion(version);
  const options = useMemo(() => dateFormatOptions(today), [today]);

  // A choice that now equals what is saved (after a save or a reset) is no longer a change. Done
  // while rendering, when the page hands down a newly loaded value, so no stale frame is painted.
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    if (draft === saved) setDraft(null);
  }

  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData): Promise<ActionState> => {
      const result = await saveAction(previous, formData);
      const loaded = parseVersionField(formData.get('version'));
      if (isStaleState(result) && loaded.ok) markStale(loaded.version);
      else if (result.status === 'ok') clearStale();
      return result;
    },
    IDLE,
  );

  const value = draft ?? saved;
  const error = state.status === 'error' ? state.fieldErrors?.['dateFormat'] : undefined;

  const reset = async (): Promise<ActionState> => {
    const result = await resetAction(version);
    if (isStaleState(result)) markStale(version);
    return result;
  };

  return (
    <Panel
      title="Date format"
      description="How dates are written on quotations, invoices and other documents. The examples show today's date."
    >
      <form action={formAction} className={shell.form} noValidate>
        <input type="hidden" name="version" value={version ?? ''} />
        <div
          className={[styles.field, isDefaultDateFormat(saved) ? undefined : shell.resettable]
            .filter(Boolean)
            .join(' ')}
        >
          <Field label="Date format" error={error}>
            {(control) => (
              <Select
                name="dateFormat"
                value={value}
                options={options}
                onChange={(event) => {
                  const next = parseDateFormat(event.target.value);
                  if (next === null) return;
                  setDraft(next === saved ? null : next);
                }}
                {...control}
              />
            )}
          </Field>
          <ResetToDefaultButton
            className={shell.resetSlot}
            section="formats"
            settingKey="format.date"
            label="Date format"
            isDefault={isDefaultDateFormat(saved)}
            defaultText={defaultDateFormatText(today)}
            action={reset}
          />
        </div>
        <FormatCardFoot state={state} pending={pending} dirty={value !== saved} stale={stale} />
      </form>
    </Panel>
  );
}

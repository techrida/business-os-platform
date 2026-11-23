'use client';

import {
  DEFAULT_NUMBER_SYSTEMS,
  type Currency,
  type NumberSystemSetting,
  type NumberSystemsSetting,
} from '@bos/contracts';
import { useActionState, useState } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import { Panel } from '@/components/ui/panel';

import { FormatCardFoot, isStaleState, useStaleVersion } from './format-card-foot';
import {
  isDefaultNumberSystem,
  numberSystemFieldName,
  numberSystemRows,
  parseVersionField,
  pruneNumberDraft,
  systemName,
} from './number-format';
import styles from './number-system-card.module.css';
import { ResetToDefaultButton } from './reset-to-default';
import { Radio, RadioGroup } from '@/components/ui/checkbox';

// The rows do not depend on anything the page loads, so they are built once.
const ROWS = numberSystemRows();

/**
 * Number grouping per currency (D30), and the amount in words that follows it. One row per currency:
 * two radio tiles, each with a worked example in that currency, the amount in words for the chosen
 * one, and an undo icon while the saved choice is not that currency's default (D32). One Save for
 * the card, on only when a choice differs from what is saved.
 *
 * Unsaved choices are overrides over the saved map, so a refresh (the Reload after a stale save)
 * keeps them. The server actions are passed in so this component owns no route.
 */
export function NumberSystemCard({
  saved,
  version,
  saveAction,
  resetAction,
}: {
  /** The map the page loaded. */
  saved: NumberSystemsSetting;
  /** The version it loaded (null when it loaded the default); sent back so a newer save is refused. */
  version: number | null;
  saveAction: (previous: ActionState, formData: FormData) => Promise<ActionState>;
  resetAction: (currency: Currency, loadedVersion: number | null) => Promise<ActionState>;
}) {
  const [draft, setDraft] = useState<Partial<NumberSystemsSetting>>({});
  const { stale, markStale, clearStale } = useStaleVersion(version);

  // A choice that now equals what is saved (after a save or a reset) is no longer a change. Done
  // while rendering, when the page hands down a newly loaded map, so no stale frame is painted.
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setDraft(pruneNumberDraft(draft, saved));
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

  const choice = (currency: Currency): NumberSystemSetting => draft[currency] ?? saved[currency];
  const dirty = ROWS.some((row) => choice(row.currency) !== saved[row.currency]);
  const error = state.status === 'error' ? state.fieldErrors?.['numberSystems'] : undefined;

  const choose = (currency: Currency, value: NumberSystemSetting) =>
    setDraft((current) => {
      const next = { ...current };
      // Choosing what is saved is not an edit, so it leaves no override behind.
      if (value === saved[currency]) delete next[currency];
      else next[currency] = value;
      return next;
    });

  const resetRow = (currency: Currency) => async (): Promise<ActionState> => {
    const result = await resetAction(currency, version);
    if (isStaleState(result)) markStale(version);
    return result;
  };

  return (
    <Panel
      title="Number grouping"
      description="Each currency groups its digits its own way. The amount in words under a document's totals follows the currency of that document."
    >
      <form action={formAction} className={shell.form} noValidate>
        <input type="hidden" name="version" value={version ?? ''} />
        <div className={styles.rows}>
          {ROWS.map((row) => {
            const selected = choice(row.currency);
            const words = row.options.find((option) => option.value === selected)?.words;
            const labelId = `number-system-${row.currency}`;
            return (
              <div key={row.currency} className={styles.row}>
                <div className={styles.head}>
                  <span id={labelId} className={styles.currency}>
                    {row.label}
                  </span>
                  <ResetToDefaultButton
                    section="formats"
                    settingKey="format.number_systems"
                    label={`${row.currency} number grouping`}
                    isDefault={isDefaultNumberSystem(row.currency, saved[row.currency])}
                    defaultText={systemName(DEFAULT_NUMBER_SYSTEMS[row.currency])}
                    action={resetRow(row.currency)}
                  />
                </div>
                <RadioGroup
                  name={numberSystemFieldName(row.currency)}
                  value={selected}
                  onValueChange={(next) => choose(row.currency, next as NumberSystemSetting)}
                  aria-labelledby={labelId}
                  className={styles.options}
                >
                  {row.options.map((option) => (
                    <label key={option.value} className={styles.option}>
                      <Radio value={option.value} className={styles.radio} />
                      <span className={styles.body}>
                        <span className={styles.name}>
                          {option.name}
                          <span className={styles.hint}>{option.hint}</span>
                        </span>
                        <span className={styles.amount}>{option.amount}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <p className={styles.words} aria-live="polite">
                  <span className={styles.wordsLabel}>In words</span> {words}
                </p>
              </div>
            );
          })}
        </div>
        {error ? (
          <span className={styles.error} role="alert">
            {error}
          </span>
        ) : null}
        <FormatCardFoot state={state} pending={pending} dirty={dirty} stale={stale} />
      </form>
    </Panel>
  );
}

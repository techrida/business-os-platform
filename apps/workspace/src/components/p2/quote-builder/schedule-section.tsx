'use client';

import { trimPercent } from '@bos/contracts';
import { Dec, formatMoney } from '@bos/locale';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Input } from '@/components/ui/field';
import { MoneyInput, PercentInput } from '@/components/ui/number-input';
import { useNumberSystems } from '@/components/ui/number-system-context';

import {
  milestoneAmounts,
  milestoneDue,
  reconcileMilestone,
  scheduleProgress,
  scheduleState,
  setMilestoneDueDate,
  type Currency,
  type MilestoneValues,
} from './model';
import styles from './quote-builder.module.css';

const MAX_MILESTONES = 12;

export interface AmountDraft {
  value: string;
  initialPercent: string;
  error?: string;
}

export function ScheduleSection({
  milestones,
  currency,
  total,
  amountDrafts,
  disabled,
  showScheduleErrors,
  errors,
  onChange,
  onAmountDraft,
  onAdd,
  onRemove,
}: {
  milestones: readonly MilestoneValues[];
  currency: Currency;
  /** The final total from the current, ready server preview. */
  total: string | null;
  amountDrafts: Readonly<Record<string, AmountDraft>>;
  disabled: boolean;
  showScheduleErrors: boolean;
  errors: Readonly<Record<string, string>>;
  onChange: (key: string, patch: Partial<MilestoneValues>) => void;
  onAmountDraft: (key: string, draft: AmountDraft | undefined) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  const numberSystems = useNumberSystems();
  const atMax = milestones.length >= MAX_MILESTONES;
  const state = scheduleState(milestones);
  const amounts = milestoneAmounts(milestones, total);
  const zeroTotal = total !== null && new Dec(total).isZero();

  function changeAmount(milestone: MilestoneValues, value: string, pricedAmount: string | null) {
    const draft = {
      value,
      initialPercent: amountDrafts[milestone.key]?.initialPercent ?? milestone.percent,
    };
    const result = reconcileMilestone(milestone.percent, { field: 'amount', value }, total);
    if (!result.ok) {
      const error =
        result.reason === 'above-total' && total !== null
          ? `Enter an amount up to ${formatMoney(total, currency, { numberSystems })}.`
          : result.reason === 'total-unavailable'
            ? 'Wait for the quote total before editing this amount.'
            : 'Enter a non-negative amount with up to two decimal places.';
      onAmountDraft(milestone.key, { ...draft, error });
      return;
    }

    if (pricedAmount !== null && new Dec(value).eq(pricedAmount)) {
      onAmountDraft(milestone.key, draft);
      return;
    }

    // Reject an amount that the four-decimal percentage cannot represent exactly.
    if (result.amount === null || !new Dec(value).eq(result.amount)) {
      const suggestion =
        result.amount === null
          ? ''
          : ` Try ${formatMoney(result.amount, currency, { numberSystems })}.`;
      onAmountDraft(milestone.key, {
        ...draft,
        error: `This amount needs more than four decimal places in the percentage.${suggestion}`,
      });
      return;
    }

    onAmountDraft(milestone.key, draft);
    onChange(milestone.key, { percent: result.percent });
  }

  return (
    <div className={styles.sectionBody}>
      {milestones.length === 0 ? (
        <p className={styles.muted}>Add milestones to split the payment.</p>
      ) : (
        <ol className={styles.milestones} aria-label="Payment milestones">
          {milestones.map((m, index) => {
            const error = (field: string) => errors[`paymentSchedule.${index}.${field}`];
            const amount = amounts[index] ?? null;
            const draft: AmountDraft | undefined = amountDrafts[m.key];
            const due = milestoneDue(m.dueDescription);
            const rowInvalid = scheduleState([m]).kind === 'invalid';
            const scheduleError = showScheduleErrors
              ? rowInvalid
                ? 'Enter 0–100% with up to four decimal places.'
                : state.kind === 'short' || state.kind === 'over'
                  ? 'Adjust the milestones to total 100%.'
                  : undefined
              : undefined;
            return (
              <li key={m.key} className={styles.milestone}>
                <div className={styles.milestoneHead}>
                  <Field label={`Milestone ${index + 1}`} error={error('label')}>
                    {(control) => (
                      <Input
                        {...control}
                        maxLength={100}
                        value={m.label}
                        onChange={(ev) => onChange(m.key, { label: ev.target.value })}
                      />
                    )}
                  </Field>
                  <Button
                    variant="ghost"
                    onClick={() => onRemove(m.key)}
                    aria-label={`Remove milestone ${index + 1}`}
                  >
                    Remove
                  </Button>
                </div>
                <div className={styles.grid2}>
                  <Field label="Percent (%)" error={error('percent') ?? scheduleError}>
                    {(control) => (
                      // The number inputs take no blur handler; blur bubbles from the box to here.
                      <div
                        onBlur={() => {
                          const result = reconcileMilestone(
                            m.percent,
                            { field: 'percent', value: m.percent },
                            total,
                          );
                          if (!result.ok) return;
                          const percent = trimPercent(result.percent);
                          if (percent !== m.percent) onChange(m.key, { percent });
                        }}
                      >
                        <PercentInput
                          {...control}
                          value={m.percent}
                          onValueChange={(value) => {
                            onAmountDraft(m.key, undefined);
                            onChange(m.key, { percent: value });
                          }}
                        />
                      </div>
                    )}
                  </Field>
                  <Field
                    label={`Amount (${currency})`}
                    error={draft?.error}
                    hint={
                      total === null
                        ? 'Amount unavailable until pricing is ready.'
                        : zeroTotal
                          ? 'Use percent to split a zero total.'
                          : draft?.error
                            ? 'Correct the amount, edit the percent, or press Escape to undo.'
                            : undefined
                    }
                  >
                    {(control) => (
                      <div
                        onBlur={() => {
                          if (draft && !draft.error) onAmountDraft(m.key, undefined);
                        }}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Escape' && draft) {
                            onChange(m.key, { percent: trimPercent(draft.initialPercent) });
                            onAmountDraft(m.key, undefined);
                          }
                        }}
                      >
                        <MoneyInput
                          {...control}
                          currency={currency}
                          max={total ?? undefined}
                          disabled={total === null}
                          readOnly={zeroTotal}
                          value={
                            total === null
                              ? ''
                              : (draft?.value ?? amount ?? (zeroTotal ? '0.00' : ''))
                          }
                          onValueChange={(value) => changeAmount(m, value, amount)}
                        />
                      </div>
                    )}
                  </Field>
                </div>
                {due.kind === 'legacy' ? (
                  <div className={styles.legacyDue}>
                    <span className={styles.stepWho}>Due when</span>
                    <span>{due.description}</span>
                    {error('dueDescription') ? (
                      <span className={styles.rowError}>{error('dueDescription')}</span>
                    ) : null}
                  </div>
                ) : (
                  <Field label="Due when" hint="Optional" error={error('dueDescription')}>
                    {(control) => (
                      <DatePicker
                        {...control}
                        disabled={disabled}
                        value={due.kind === 'date' ? due.date : ''}
                        onChange={(date) => {
                          const result = setMilestoneDueDate(m.dueDescription, date);
                          if (result.ok) onChange(m.key, { dueDescription: result.dueDescription });
                        }}
                      />
                    )}
                  </Field>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className={styles.actions}>
        {/* aria-disabled, not disabled: it stays focusable so the Tooltip can say why (UIP-FORM-011). */}
        <Tooltip content={atMax ? `Up to ${MAX_MILESTONES} milestones.` : undefined}>
          <Button
            variant="secondary"
            aria-disabled={atMax || undefined}
            onClick={() => {
              if (!atMax) onAdd();
            }}
          >
            Add milestone
          </Button>
        </Tooltip>
        {milestones.length > 0 ? (
          <p
            role="status"
            className={styles.scheduleTotal}
            data-invalid={(showScheduleErrors && state.kind !== 'ok') || undefined}
          >
            {scheduleProgress(milestones)}% / 100% allocated
          </p>
        ) : null}
      </div>
    </div>
  );
}

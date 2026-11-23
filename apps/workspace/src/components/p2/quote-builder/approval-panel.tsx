'use client';

import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { MemberPicker } from '@/components/ui/member-picker';
import { Panel } from '@/components/ui/panel';
import { humanizeKey } from '@/lib/kernel-ui';

import { discountAboveThreshold } from './model';
import styles from './quote-builder.module.css';
import type { PreviewResult } from './schemas';
import type { PreviewState } from './totals-panel';

type Step = PreviewResult['route']['steps'][number];
type ApproverOption = NonNullable<PreviewResult['approverChoice']>['options'][number];

/** The role that lets a person approve, as the picker names it. */
function roleName(roleKey: string): string {
  return humanizeKey(roleKey);
}

/** What the approver picker shows muted after the name: their approval role and, with no address, that fact. */
export function approverOptionRole(o: ApproverOption): string {
  return [roleName(o.roleKey), o.hasEmail ? null : 'no email'].filter(Boolean).join(' · ');
}

/** Shown next to a chosen approver without an email address. */
function NoEmailBadge() {
  return (
    <Badge tone="warning" className={styles.noEmail}>
      <Icon name="alert-triangle" size={14} />
      No email
    </Badge>
  );
}

function stepLabel({ kind, roleKey }: Step): string {
  if (kind === 'group') return 'Any group member';
  if (kind === 'user') return 'Designated approver';
  switch (roleKey) {
    case 'accountant':
      return 'Any accountant';
    case 'finance':
      return 'Any finance approver';
    case 'management':
      return 'Any manager';
    case 'founder':
      return 'Any founder';
    default:
      return roleKey
        ? `Any ${humanizeKey(roleKey).toLowerCase()} approver`
        : 'Any eligible approver';
  }
}

function ApproverNames({ names, group }: { names: readonly string[]; group: string }) {
  const container = useRef<HTMLDivElement>(null);
  const measureRow = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const row = container.current;
    const measure = measureRow.current;
    if (!row || !measure) return;
    function update() {
      if (!row || !measure) return;
      const chips = Array.from(measure.children, (chip) => chip.getBoundingClientRect().width);
      const overflow = chips.pop() ?? 0;
      const gap = parseFloat(getComputedStyle(measure).columnGap) || 0;
      const available = row.clientWidth;
      const all = chips.reduce((sum, width, index) => sum + width + (index ? gap : 0), 0);
      if (all <= available) {
        setVisibleCount(names.length);
        return;
      }

      let used = overflow;
      let count = 0;
      for (const width of chips) {
        if (used + gap + width > available) break;
        used += gap + width;
        count++;
      }
      setVisibleCount(count);
    }

    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(measure);
    update();
    return () => observer.disconnect();
  }, [names]);

  const hidden = names.slice(visibleCount);
  return (
    <div ref={container} className={styles.nameChips}>
      {names.slice(0, visibleCount).map((name, i) => (
        <Badge key={i}>{name}</Badge>
      ))}
      {hidden.length > 0 ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              variant="ghost"
              size="small"
              className={styles.moreNames}
              aria-label={`Show ${hidden.length} more for ${group}`}
            >
              +{hidden.length}
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className={styles.namesPopover}
              align="start"
              sideOffset={6}
              aria-label={`More eligible staff for ${group}`}
            >
              <ul className={styles.nameList}>
                {hidden.map((name, i) => (
                  <li key={i}>{name}</li>
                ))}
              </ul>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
      <div aria-hidden="true" className={styles.nameMeasureClip}>
        <div ref={measureRow} className={styles.nameMeasure}>
          {names.map((name, i) => (
            <Badge key={i}>{name}</Badge>
          ))}
          <span className={styles.moreNames}>+{names.length}</span>
        </div>
      </div>
    </div>
  );
}

export function ApprovalSteps({
  steps,
  assigned,
}: {
  steps: readonly Step[];
  /** The person chosen for one step; that step then names them instead of its eligible group. */
  assigned?: { seq: number; option: ApproverOption } | null | undefined;
}) {
  return (
    <ol className={styles.steps} aria-label="Approval steps">
      {steps.map((step) => {
        const named = assigned?.seq === step.seq ? assigned.option : null;
        const group = named ? named.name : stepLabel(step);
        return (
          <li key={step.seq} className={styles.step}>
            <div className={styles.stepHead}>
              <span className={styles.stepWho}>{group}</span>
              {named ? <Badge tone="info">Chosen</Badge> : null}
              {named && !named.hasEmail ? <NoEmailBadge /> : null}
              {step.blocked && !named ? <Badge tone="warning">Unavailable</Badge> : null}
            </div>
            {named ? null : step.eligibleStaffNames?.length ? (
              <ApproverNames names={step.eligibleStaffNames} group={group} />
            ) : null}
            <p className={styles.muted}>{step.reason.replace(/^Base route: /, '')}</p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Choose who decides the first approval step. "Anyone eligible" (the empty value) keeps today's route: every
 * eligible approver of the step sees it. The server checks the choice again when the quotation is submitted.
 */
function ApproverPicker({
  step,
  options,
  value,
  onChange,
}: {
  step: Step;
  options: readonly ApproverOption[];
  value: string;
  onChange: (userId: string) => void;
}) {
  const chosen = options.find((o) => o.userId === value);
  return (
    <div className={styles.approverPicker}>
      <Field
        label={`Approver for step ${step.seq}`}
        hint="Optional: leave it empty and anyone eligible can decide. Only the person you choose sees this step in their Inbox and can decide it. You cannot choose yourself."
      >
        {(control) => (
          <MemberPicker
            labelledBy={control['aria-labelledby']}
            describedBy={control['aria-describedby']}
            people={options.map((o) => ({
              id: o.userId,
              name: o.name,
              role: approverOptionRole(o),
            }))}
            value={chosen ? value : ''}
            onChange={onChange}
            placeholder={`${stepLabel(step)} (anyone eligible)`}
          />
        )}
      </Field>
      {chosen && !chosen.hasEmail ? (
        <p className={styles.approverNote}>
          <NoEmailBadge />
          <span>They get a bell notice and the Inbox item, not an email.</span>
        </p>
      ) : null}
    </div>
  );
}

export function ApprovalPanel({
  state,
  preview,
  message,
  approver = '',
  onApproverChange,
}: {
  state: PreviewState;
  preview?: PreviewResult | null | undefined;
  message?: string | undefined;
  /** The chosen first-step approver's user id, or '' for anyone eligible. */
  approver?: string;
  onApproverChange?: (userId: string) => void;
}) {
  const plan = state === 'ready' ? preview?.route : null;
  const choice = state === 'ready' ? preview?.approverChoice : null;
  const choiceStep = choice ? plan?.steps.find((s) => s.seq === choice.seq) : undefined;
  const chosen = choice?.options.find((o) => o.userId === approver);
  const discountTriggers =
    plan && preview && discountAboveThreshold(preview.totals.effectiveDiscountPct);

  return (
    <Panel title="Approval requirements" className={styles.sectionBody}>
      {discountTriggers && preview ? (
        <Alert tone="warning" title="This discount needs approval">
          The discount is {preview.totals.effectiveDiscountPct}%, above the 12% threshold.
        </Alert>
      ) : null}
      {plan ? (
        plan.steps.length === 0 ? (
          <p className={styles.muted}>No approval steps apply.</p>
        ) : (
          <>
            <ApprovalSteps
              steps={plan.steps}
              assigned={chosen && choice ? { seq: choice.seq, option: chosen } : null}
            />
            {choice && choiceStep && choice.options.length > 0 && onApproverChange ? (
              <ApproverPicker
                step={choiceStep}
                options={choice.options}
                value={approver}
                onChange={onApproverChange}
              />
            ) : null}
          </>
        )
      ) : state === 'loading' ? (
        <p role="status" className={styles.muted}>
          Checking approval requirements
        </p>
      ) : (
        <p className={styles.muted}>
          {state === 'needs_save'
            ? 'Save the draft to see who will approve it.'
            : state === 'starting'
              ? 'Who will approve it appears once the page has finished loading.'
              : (message ?? 'Complete the lines to see who will approve.')}
        </p>
      )}
      {plan?.blocked ? (
        <Alert tone="warning" title="An approval step has no eligible approvers">
          {plan.blockReason ?? 'Ask an administrator to review the approval rules.'}
        </Alert>
      ) : null}
    </Panel>
  );
}

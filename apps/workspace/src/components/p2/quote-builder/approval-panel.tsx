'use client';

import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { humanizeKey } from '@/lib/kernel-ui';

import { discountAboveThreshold } from './model';
import styles from './quote-builder.module.css';
import type { PreviewResult } from './schemas';
import type { PreviewState } from './totals-panel';

type Step = PreviewResult['route']['steps'][number];

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

export function ApprovalSteps({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className={styles.steps} aria-label="Approval steps">
      {steps.map((step) => {
        const group = stepLabel(step);
        return (
          <li key={step.seq} className={styles.step}>
            <div className={styles.stepHead}>
              <span className={styles.stepWho}>{group}</span>
              {step.blocked ? <Badge tone="warning">Unavailable</Badge> : null}
            </div>
            {step.eligibleStaffNames?.length ? (
              <ApproverNames names={step.eligibleStaffNames} group={group} />
            ) : null}
            <p className={styles.muted}>{step.reason.replace(/^Base route: /, '')}</p>
          </li>
        );
      })}
    </ol>
  );
}

export function ApprovalPanel({
  state,
  preview,
  message,
}: {
  state: PreviewState;
  preview?: PreviewResult | null | undefined;
  message?: string | undefined;
}) {
  const plan = state === 'ready' ? preview?.route : null;
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
          <ApprovalSteps steps={plan.steps} />
        )
      ) : state === 'loading' ? (
        <p role="status" className={styles.muted}>
          Checking approval requirements
        </p>
      ) : (
        <p className={styles.muted}>
          {state === 'needs_save'
            ? 'Save the draft to see who will approve it.'
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

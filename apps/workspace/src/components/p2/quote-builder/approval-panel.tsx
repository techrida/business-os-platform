import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import { humanizeKey } from '@/lib/kernel-ui';

import { discountAboveThreshold } from './model';
import type { PreviewResult } from './schemas';
import styles from './quote-builder.module.css';
import type { PreviewState } from './totals-panel';

/**
 * Section 8: who must approve this quotation, and why. The steps and their reasons are the
 * platform's dry run of the approval route on this draft; the page only lays them out. The one
 * thing it adds is the 12% flag: when the server's effective discount is above 12 it says so,
 * because that is the rule people ask about first.
 */
export function ApprovalPanel({
  state,
  preview,
  message,
}: {
  state: PreviewState;
  preview?: PreviewResult | null | undefined;
  message?: string | undefined;
}) {
  const plan = (state === 'ready' || state === 'loading') && preview ? preview.route : null;
  const discountTriggers =
    plan !== null && preview ? discountAboveThreshold(preview.totals.effectiveDiscountPct) : false;

  return (
    <Panel
      as="aside"
      title="8. Approval requirements"
      description="Who will be asked to approve, and why. Worked out again when you submit."
      className={styles.approval}
    >
      {discountTriggers && preview ? (
        <Alert tone="warning" title="This discount needs approval">
          The discount is {preview.totals.effectiveDiscountPct}%, which is above 12%. A manager has
          to approve it before the quotation can be sent.
        </Alert>
      ) : null}

      {plan ? (
        plan.steps.length === 0 ? (
          <p className={styles.muted}>
            The platform found no approval step for this draft as it stands.
          </p>
        ) : (
          <ol className={styles.steps}>
            {plan.steps.map((s) => (
              <li key={s.seq} className={styles.step}>
                <span className={styles.stepNo} aria-hidden="true">
                  {s.seq}
                </span>
                <div className={styles.stepBody}>
                  <div className={styles.stepHead}>
                    <span className={styles.stepWho}>
                      <span className="sr-only">Step {s.seq}: </span>
                      {s.kind === 'role' && s.roleKey
                        ? `Anyone with the ${humanizeKey(s.roleKey).toLowerCase()} role`
                        : s.kind === 'group'
                          ? 'An approval group'
                          : 'A named person'}
                    </span>
                    {s.blocked ? <Badge tone="warning">No one available</Badge> : null}
                  </div>
                  <p className={styles.stepReason}>{s.reason}</p>
                </div>
              </li>
            ))}
          </ol>
        )
      ) : state === 'loading' ? (
        <p role="status" className={styles.muted}>
          Checking the approval route
        </p>
      ) : (
        <p className={styles.muted}>
          {state === 'needs_save'
            ? 'Save the draft to see who will have to approve it.'
            : (message ?? 'Complete every line to see who will have to approve it.')}
        </p>
      )}

      {plan?.blocked ? (
        <Alert tone="warning" title="Nobody can approve a step yet">
          {plan.blockReason ??
            'Everyone eligible prepared this quotation, so they cannot approve it.'}{' '}
          Submitting is refused until an administrator fixes the route.
        </Alert>
      ) : null}
    </Panel>
  );
}

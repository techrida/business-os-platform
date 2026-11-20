// Test-only. Publishing a workflow needs a second person (F1-Q11, D7): the API refuses a publish by whoever saved the
// draft. Fixtures that save a workflow and then publish it publish through a caller made here: the same tenant,
// entity, actor and grants, another user id.
import { randomUUID } from 'node:crypto';

import type { PublisherCheck } from '../../src/modules/approvals/admin.service';
import type { ApprovalsCaller } from '../../src/modules/approvals/ports';

export function asSecondPerson(
  caller: Pick<ApprovalsCaller, 'current'>,
  userId: string = randomUUID(),
): ApprovalsCaller {
  return {
    current: () => {
      const c = caller.current();
      return { ...c, principal: { ...c.principal, userId } };
    },
  };
}

/**
 * Test-only: publishes without re-checking the publisher's live grant. Fixtures here publish through a made-up second
 * user who has no mirror row, so the live check would refuse them; the HTTP route always runs the real check
 * (approvals.integration.test.ts covers it).
 */
export const SKIP_LIVE_PUBLISHER_CHECK: PublisherCheck = () => Promise.resolve();

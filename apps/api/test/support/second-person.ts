// Test-only. Publishing a workflow needs a second person (F1-Q11, D7): the API refuses a publish by whoever saved the
// draft. Fixtures that save a workflow and then publish it publish through a caller made here: the same tenant,
// entity, actor and grants, another user id.
import { randomUUID } from 'node:crypto';

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

import type { ApprovalRequestDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApprovalActions } from './approval-actions';

const ADA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const actions: ApprovalRequestDto['actions'] = [
  {
    action: 'submit',
    actorUserId: ADA,
    onBehalfOfUserId: null,
    comment: null,
    createdAt: '2026-11-20T06:00:00.000Z',
  },
  {
    action: 'approve',
    actorUserId: BEN,
    onBehalfOfUserId: ADA,
    comment: 'Fine by me',
    createdAt: '2026-11-21T06:00:00.000Z',
  },
];

describe('ApprovalActions', () => {
  it('names who acted, for whom and when, with the comment', () => {
    const html = renderToStaticMarkup(
      <ApprovalActions
        actions={actions}
        people={[
          { userId: ADA, name: 'Ada Lovelace' },
          { userId: BEN, name: 'Ben Franklin' },
        ]}
      />,
    );
    expect(html).toContain('Submitted');
    expect(html).toContain('by Ada Lovelace');
    expect(html).toContain('Approved');
    expect(html).toContain('by Ben Franklin for Ada Lovelace');
    expect(html).toContain('Fine by me');
    expect(html).toContain('dateTime="2026-11-21T06:00:00.000Z"');
  });

  it('never shows an id for a person the read did not name', () => {
    const html = renderToStaticMarkup(<ApprovalActions actions={actions} people={undefined} />);
    expect(html).toContain('Person name unavailable');
    expect(html).not.toContain(ADA);
  });

  it('says "automatically" for a step the system took, not a missing name', () => {
    const html = renderToStaticMarkup(
      <ApprovalActions
        actions={[
          {
            action: 'escalate',
            actorUserId: 'system',
            onBehalfOfUserId: null,
            comment: null,
            createdAt: '2026-11-21T06:00:00.000Z',
          },
        ]}
        people={[]}
      />,
    );
    expect(html).toContain('Escalated after the deadline');
    expect(html).toContain('automatically');
    expect(html).not.toContain('Person name unavailable');
  });

  it('names no one for a block, and never prints an id inside a comment', () => {
    const html = renderToStaticMarkup(
      <ApprovalActions
        actions={[
          {
            action: 'block',
            actorUserId: ADA,
            onBehalfOfUserId: null,
            comment: `Step 2 (user ${BEN}) cannot approve`,
            createdAt: '2026-11-21T06:00:00.000Z',
          },
        ]}
        people={[{ userId: ADA, name: 'Ada Lovelace' }]}
      />,
    );
    expect(html).toContain('automatically');
    expect(html).not.toContain('by Ada Lovelace');
    expect(html).not.toContain(BEN);
    expect(html).toContain('Step 2 (user an approver) cannot approve');
  });

  it('draws nothing before the first action', () => {
    expect(renderToStaticMarkup(<ApprovalActions actions={[]} people={[]} />)).toBe('');
  });
});

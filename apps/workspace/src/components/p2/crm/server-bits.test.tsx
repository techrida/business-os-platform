import type { ActivityDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ActivityList,
  activityState,
  FILTER_KINDS,
  historyItems,
  historyMeta,
  LOGGABLE_KINDS,
} from './server-bits';

const ASHA = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-19T06:00:00.000Z');

function activity(over: Partial<ActivityDto> = {}): ActivityDto {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'call',
    subject: 'Asked for a revised quote',
    body: null,
    leadId: '33333333-3333-4333-8333-333333333333',
    opportunityId: null,
    customerId: null,
    contactId: null,
    quotationId: null,
    dueAt: null,
    assigneeUserId: null,
    assigneeName: null,
    completedAt: null,
    cancelledAt: null,
    planned: false,
    createdByUserId: ASHA,
    createdByName: 'Asha Rai',
    occurredAt: '2026-11-18T04:00:00.000Z',
    version: 1,
    ...over,
  };
}

const planned = (dueAt: string) =>
  activity({ id: '44444444-4444-4444-8444-444444444444', dueAt, planned: true });

describe('kind lists', () => {
  it('logs only call, meeting, email and note', () => {
    expect(LOGGABLE_KINDS).toEqual([
      { value: 'call', label: 'Call' },
      { value: 'meeting', label: 'Meeting' },
      { value: 'email', label: 'Email' },
      { value: 'note', label: 'Note' },
    ]);
  });

  it('filters by every kind except task', () => {
    const values = FILTER_KINDS.map((k) => k.value);
    expect(values).not.toContain('task');
    expect(values).toEqual(['call', 'meeting', 'email', 'note', 'stage_change', 'system']);
  });
});

describe('historyItems', () => {
  it('drops planned and cancelled rows, keeps logged and completed ones in order', () => {
    const logged = activity({ id: 'a1' });
    const done = activity({
      id: 'a2',
      dueAt: '2026-11-17T04:00:00.000Z',
      completedAt: '2026-11-18T05:00:00.000Z',
    });
    const cancelled = activity({
      id: 'a3',
      dueAt: '2026-11-20T04:00:00.000Z',
      cancelledAt: '2026-11-18T05:00:00.000Z',
    });
    expect(historyItems([logged, planned('2026-11-20T04:00:00.000Z'), done, cancelled])).toEqual([
      logged,
      done,
    ]);
  });
});

describe('activityState', () => {
  it('is Planned before the due time and Overdue after it', () => {
    expect(activityState(planned('2026-11-19T07:00:00.000Z'), NOW)).toBe('Planned');
    expect(activityState(planned('2026-11-19T05:59:00.000Z'), NOW)).toBe('Overdue');
  });

  it('is Done once completed, and nothing for a plain logged activity', () => {
    const done = activity({
      dueAt: '2026-11-17T04:00:00.000Z',
      completedAt: '2026-11-18T05:00:00.000Z',
    });
    expect(activityState(done, NOW)).toBe('Done');
    expect(activityState(activity(), NOW)).toBeNull();
  });
});

describe('historyMeta', () => {
  it('shows the completion time for a completed follow-up and who scheduled it', () => {
    const done = activity({
      dueAt: '2026-11-17T04:00:00.000Z',
      completedAt: '2026-11-18T09:30:00.000Z',
      occurredAt: '2026-11-18T09:00:00.000Z',
    });
    expect(historyMeta(done)).toEqual({
      at: '2026-11-18T09:30:00.000Z',
      actor: 'Scheduled by Asha Rai',
    });
  });

  it('shows when a logged activity happened and who logged it', () => {
    expect(historyMeta(activity())).toEqual({
      at: '2026-11-18T04:00:00.000Z',
      actor: 'Logged by Asha Rai',
    });
  });

  it('leaves the actor out for older rows that name no author', () => {
    expect(historyMeta(activity({ createdByUserId: null, createdByName: null })).actor).toBeNull();
  });
});

describe('ActivityList', () => {
  it('renders History without planned rows and with the actor', () => {
    const html = renderToStaticMarkup(
      <ActivityList
        items={[activity(), { ...planned('2026-11-20T04:00:00.000Z'), subject: 'Call back' }]}
        empty="Nothing yet"
      />,
    );
    expect(html).toContain('Asked for a revised quote');
    expect(html).toContain('Logged by Asha Rai');
    expect(html).not.toContain('Call back');
    expect(html).not.toContain('Due');
  });

  it('shows the empty state when only planned rows arrive', () => {
    const html = renderToStaticMarkup(
      <ActivityList items={[planned('2026-11-20T04:00:00.000Z')]} empty="Nothing yet" />,
    );
    expect(html).toContain('No activity yet');
    expect(html).toContain('Nothing yet');
  });
});

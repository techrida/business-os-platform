import type { QuotationStatusHistoryDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { historyRows, historyTitle, StatusHistory } from './status-history';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbaaaa1234';

const revisions = [
  { id: V1, revisionNo: 1 },
  { id: V2, revisionNo: 2 },
];

function entry(over: Partial<QuotationStatusHistoryDto> = {}): QuotationStatusHistoryDto {
  return {
    versionId: V1,
    fromStatus: 'draft',
    toStatus: 'submitted',
    actorId: ACTOR,
    reason: null,
    at: '2026-11-08T05:45:00.000Z',
    ...over,
  };
}

describe('historyRows', () => {
  it('lists the newest change first, whatever order the API sent', () => {
    const rows = historyRows(
      [
        entry({ at: '2026-11-01T05:45:00.000Z', fromStatus: null, toStatus: 'draft' }),
        entry({ at: '2026-11-08T05:45:00.000Z' }),
        entry({ at: '2026-11-05T05:45:00.000Z', toStatus: 'returned', fromStatus: 'submitted' }),
      ],
      revisions,
    );
    expect(rows.map((r) => r.at)).toEqual([
      '2026-11-08T05:45:00.000Z',
      '2026-11-05T05:45:00.000Z',
      '2026-11-01T05:45:00.000Z',
    ]);
  });

  it('keeps the API order reversed when two changes share a timestamp', () => {
    const at = '2026-11-08T05:45:00.000Z';
    const rows = historyRows(
      [
        entry({ at, fromStatus: null, toStatus: 'draft' }),
        entry({ at, fromStatus: 'draft', toStatus: 'submitted' }),
      ],
      revisions,
    );
    expect(rows.map((r) => r.title)).toEqual(['Submitted for approval', 'Draft created']);
  });

  it('words the first entry as a creation and the rest as a change, in plain labels', () => {
    const [created] = historyRows([entry({ fromStatus: null, toStatus: 'draft' })], revisions);
    expect(created?.title).toBe('Draft created');
    const [changed] = historyRows([entry({ fromStatus: 'sent', toStatus: 'accepted' })], revisions);
    expect(changed?.title).toBe('Accepted by the customer');
  });

  it('names the revision, and leaves it out for a version it does not know', () => {
    const rows = historyRows([entry({ versionId: V2 }), entry({ versionId: 'x' })], revisions);
    expect(rows.map((r) => r.revision)).toEqual([null, 'Rev 2']);
  });

  it('uses a permitted directory name without changing stored actor references', () => {
    const event = entry();
    const [row] = historyRows([event], revisions, new Map([[event.actorId!, 'Mina']]));
    expect(row?.actor).toBe('Mina');
    expect(event.actorId).not.toBe('Mina');
  });
  it('says "System" when no person did it, and an unavailable name otherwise', () => {
    const [system] = historyRows([entry({ actorId: null })], revisions);
    expect(system?.actor).toBe('System');
    const [person] = historyRows([entry()], revisions);
    expect(person?.actor).toBe('Person name unavailable');
  });
});

describe('historyTitle', () => {
  it('has a plain sentence for every status a change can end in', () => {
    expect(historyTitle('submitted', 'approved')).toBe('Approved');
    expect(historyTitle('approved', 'sent')).toBe('Sent to the customer');
    expect(historyTitle('submitted', 'returned')).toBe('Returned for changes');
    expect(historyTitle('returned', 'submitted')).toBe('Resubmitted for approval');
    expect(historyTitle('sent', 'expired')).toBe('Expired');
    expect(historyTitle('draft', 'cancelled')).toBe('Cancelled');
    expect(historyTitle('sent', 'superseded')).toBe('Replaced by a newer revision');
  });

  it('labels a restore as such, not as a second approval or send (R6D)', () => {
    expect(historyTitle('superseded', 'sent', null, 'Revision 2 cancelled: not needed')).toBe(
      'Restored after revision 2 was cancelled',
    );
    expect(historyTitle('superseded', 'approved', null, 'Revision 3 cancelled: x')).toBe(
      'Restored after revision 3 was cancelled',
    );
    expect(historyTitle('superseded', 'sent')).toBe('Restored after a revision was cancelled');
  });

  it('says who rejected only when the version knows', () => {
    expect(historyTitle('sent', 'rejected', 'customer')).toBe('Rejected by the customer');
    expect(historyTitle('submitted', 'rejected', 'internal')).toBe('Rejected internally');
    expect(historyTitle('sent', 'rejected')).toBe('Rejected');
  });

  it('names a creation in any other status in the badge label', () => {
    expect(historyTitle(null, 'submitted')).toBe('Created as Awaiting approval');
  });

  it('feeds the rejection source of each version into its rows', () => {
    const [row] = historyRows(
      [entry({ fromStatus: 'sent', toStatus: 'rejected' })],
      [{ id: V1, revisionNo: 1, rejectionSource: 'customer' }],
    );
    expect(row?.title).toBe('Rejected by the customer');
  });
});

describe('StatusHistory', () => {
  it('says so when nothing has changed yet', () => {
    const html = renderToStaticMarkup(<StatusHistory history={[]} versions={revisions} />);
    expect(html).toContain('No status changes yet.');
    expect(html).not.toContain('<ol');
  });

  it('prints each change with its reason, a machine-readable time and the heading', () => {
    const html = renderToStaticMarkup(
      <StatusHistory
        history={[entry({ reason: 'Customer asked for a lower price' })]}
        versions={revisions}
      />,
    );
    expect(html).toContain('Status history');
    expect(html).toContain('Submitted for approval');
    expect(html).toContain('Customer asked for a lower price');
    expect(html).toContain('dateTime="2026-11-08T05:45:00.000Z"');
  });

  it('keeps a very long reason as text inside the row', () => {
    const reason = 'x'.repeat(2000);
    const html = renderToStaticMarkup(
      <StatusHistory history={[entry({ reason })]} versions={revisions} />,
    );
    expect(html).toContain(reason);
  });
});

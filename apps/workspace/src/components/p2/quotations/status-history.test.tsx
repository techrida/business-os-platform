import type { QuotationStatusHistoryDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { historyRows, StatusHistory } from './status-history';

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
    expect(rows.map((r) => r.title)).toEqual([
      'Changed from Draft to Awaiting approval',
      'Created as Draft',
    ]);
  });

  it('words the first entry as a creation and the rest as a change, in plain labels', () => {
    const [created] = historyRows([entry({ fromStatus: null, toStatus: 'draft' })], revisions);
    expect(created?.title).toBe('Created as Draft');
    const [changed] = historyRows([entry({ fromStatus: 'sent', toStatus: 'accepted' })], revisions);
    expect(changed?.title).toBe('Changed from Sent to Accepted');
  });

  it('names the revision, and leaves it out for a version it does not know', () => {
    const rows = historyRows([entry({ versionId: V2 }), entry({ versionId: 'x' })], revisions);
    expect(rows.map((r) => r.revision)).toEqual([null, 'Rev 2']);
  });

  it('says "System" when no person did it, and an unavailable-name label otherwise', () => {
    const [system] = historyRows([entry({ actorId: null })], revisions);
    expect(system?.actor).toBe('System');
    const [person] = historyRows([entry()], revisions);
    expect(person?.actor).toBe('Name unavailable');
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
    expect(html).toContain('Changed from Draft to Awaiting approval');
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { POSTING_EVENTS as SCHEMA_POSTING_EVENTS } from '@bos/db';
import { describe, expect, it } from 'vitest';

import { P3_POSTING_EVENTS, P4_POSTING_EVENTS, POSTING_EVENTS, isPostingEvent } from './posting-events';

// The PostingEvent union must name exactly the events the database accepts: a missing value is a type that
// cannot be written, an extra one an INSERT that fails on posting_events_event_check at run time.

const MIGRATION = fileURLToPath(
  new URL('../../../../../packages/db/migrations/0019_open_items.sql', import.meta.url),
);

/** The values of `posting_events_event_check`, parsed from the migration that creates it. */
function eventsInCheck(): string[] {
  const sqlText = readFileSync(MIGRATION, 'utf8');
  const match = /"posting_events_event_check" CHECK \("event" in \(([^)]*)\)\)/.exec(sqlText);
  if (!match?.[1]) throw new Error('posting_events_event_check not found in 0019_open_items.sql');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('PostingEvent', () => {
  it('equals the posting_events_event_check values of 0019_open_items.sql', () => {
    const inDb = eventsInCheck();
    expect(inDb).toHaveLength(10);
    expect([...POSTING_EVENTS].sort()).toEqual([...inDb].sort());
  });

  it('equals the Drizzle schema list', () => {
    expect([...POSTING_EVENTS].sort()).toEqual([...SCHEMA_POSTING_EVENTS].sort());
  });

  it('splits into the seven P3 events and the three P4 events', () => {
    expect(P3_POSTING_EVENTS).toEqual([
      'invoice_issued',
      'debit_note_issued',
      'credit_note_issued',
      'payment_verified',
      'payment_reversed',
      'allocation',
      'allocation_reversed',
    ]);
    expect(P4_POSTING_EVENTS).toEqual([
      'vendor_bill_posted',
      'vendor_payment_made',
      'vendor_debit_note_issued',
    ]);
    expect(new Set(POSTING_EVENTS).size).toBe(POSTING_EVENTS.length);
  });

  it('narrows strings with isPostingEvent', () => {
    expect(isPostingEvent('invoice_issued')).toBe(true);
    expect(isPostingEvent('vendor_debit_note_issued')).toBe(true);
    expect(isPostingEvent('invoice_paid')).toBe(false);
  });
});

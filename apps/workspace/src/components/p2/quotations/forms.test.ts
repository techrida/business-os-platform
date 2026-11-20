import { describe, expect, it } from 'vitest';

import { parseCancel, parseOutcome, parseRevise, parseSend } from './forms';

const CONTACT = '44444444-4444-4444-8444-444444444444';
const TODAY = '2026-11-08';

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe('parseSend', () => {
  it('builds the body from the recipient, the optional message and the version row', () => {
    const got = parseSend(
      form([
        ['recipientContactId', CONTACT],
        ['message', '  Please review.  '],
        ['expectedVersion', '4'],
      ]),
    );
    expect(got).toEqual({
      ok: true,
      body: { recipientContactId: CONTACT, message: 'Please review.', expectedVersion: 4 },
    });
  });

  it('leaves the message out when it is blank, because the schema refuses an empty string', () => {
    const got = parseSend(
      form([
        ['recipientContactId', CONTACT],
        ['message', '   '],
        ['expectedVersion', '1'],
      ]),
    );
    expect(got.ok && 'message' in got.body).toBe(false);
  });

  it('names the recipient field when none is chosen', () => {
    const got = parseSend(
      form([
        ['recipientContactId', ''],
        ['expectedVersion', '1'],
      ]),
    );
    expect(got).toEqual({ ok: false, errors: { recipient: 'Choose who should receive it.' } });
  });

  it('flags a lost version as a broken form, not a field', () => {
    const got = parseSend(form([['recipientContactId', CONTACT]]));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.errors.form).toMatch(/Reload/);
  });
});

describe('parseOutcome', () => {
  const base: [string, string][] = [
    ['decidedOn', TODAY],
    ['expectedVersion', '2'],
  ];

  it('accepts with one evidence kind', () => {
    const got = parseOutcome(
      form([...base, ['outcome', 'accepted'], ['evidenceKinds', 'signed_quote']]),
      TODAY,
    );
    expect(got).toEqual({
      ok: true,
      body: {
        outcome: 'accepted',
        decidedOn: TODAY,
        evidenceKinds: ['signed_quote'],
        expectedVersion: 2,
      },
    });
  });

  it('refuses accepted without evidence, on the evidence field', () => {
    const got = parseOutcome(form([...base, ['outcome', 'accepted']]), TODAY);
    expect(got.ok).toBe(false);
    expect(!got.ok && Object.keys(got.errors)).toEqual(['evidence']);
  });

  it('refuses rejected without a comment, and accepts it with one and no evidence', () => {
    const blank = parseOutcome(form([...base, ['outcome', 'rejected'], ['comment', '  ']]), TODAY);
    expect(blank.ok).toBe(false);
    expect(!blank.ok && Object.keys(blank.errors)).toEqual(['comment']);
    const ok = parseOutcome(
      form([...base, ['outcome', 'rejected'], ['comment', 'Went with a competitor']]),
      TODAY,
    );
    expect(ok.ok).toBe(true);
  });

  it('asks for an outcome when none is chosen', () => {
    const got = parseOutcome(form(base), TODAY);
    expect(!got.ok && got.errors.outcome).toMatch(/accepted or rejected/);
  });

  it('refuses a date in the future and a date that is not a date', () => {
    for (const [value, words] of [
      ['2026-11-09', /future/],
      ['08/11/2026', /date/],
      ['', /date/],
    ] as const) {
      const got = parseOutcome(
        form([
          ['outcome', 'rejected'],
          ['comment', 'No'],
          ['decidedOn', value],
          ['expectedVersion', '2'],
        ]),
        TODAY,
      );
      expect(got.ok).toBe(false);
      expect(!got.ok && got.errors.decidedOn).toMatch(words);
    }
  });

  it('ignores an evidence kind the contract does not know', () => {
    const got = parseOutcome(
      form([...base, ['outcome', 'accepted'], ['evidenceKinds', 'handshake']]),
      TODAY,
    );
    expect(got.ok).toBe(false);
  });
});

describe('parseRevise', () => {
  it('needs a reason', () => {
    const got = parseRevise(
      form([
        ['reason', '   '],
        ['expectedVersion', '3'],
      ]),
    );
    expect(got.ok).toBe(false);
    expect(!got.ok && got.errors.reason).toMatch(/Say why/);
  });

  it('builds the body with the trimmed reason and the version row', () => {
    const got = parseRevise(
      form([
        ['reason', ' Smaller scope '],
        ['expectedVersion', '3'],
      ]),
    );
    expect(got).toEqual({ ok: true, body: { reason: 'Smaller scope', expectedVersion: 3 } });
  });

  it('names a reason that is too long', () => {
    const got = parseRevise(
      form([
        ['reason', 'x'.repeat(1001)],
        ['expectedVersion', '3'],
      ]),
    );
    expect(!got.ok && got.errors.reason).toMatch(/1000/);
  });
});

describe('parseCancel', () => {
  it('sends the revision the person looked at, so a stale page cannot cancel a newer one', () => {
    const got = parseCancel(
      form([
        ['reason', ' No longer needed '],
        ['expectedVersion', '1'],
        ['versionId', CONTACT],
      ]),
    );
    expect(got).toEqual({
      ok: true,
      body: { reason: 'No longer needed', expectedVersion: 1, versionId: CONTACT },
    });
  });
});

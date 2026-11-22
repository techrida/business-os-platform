import { describe, expect, it } from 'vitest';

import {
  DEADLINE_IN_PAST,
  DEADLINE_NOT_LATER,
  deadlineToIso,
  emptyQuoteValues,
  isoToKathmanduLocal,
  parseExtensionValues,
  parseQuoteValues,
  parseRecommendValues,
  parseRfqValues,
  parseScoreValues,
  quoteValuesFromForm,
  recommendValuesFromForm,
  rfqValuesFromForm,
  scoreValuesFromForm,
  type QuoteValues,
} from './forms';

const PR = '11111111-1111-4111-8111-111111111111';
const V1 = '22222222-2222-4222-8222-222222222222';
const V2 = '33333333-3333-4333-8333-333333333333';
const TAX = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';
const SUB = '66666666-6666-4666-8666-666666666666';
const LINE1 = '77777777-7777-4777-8777-777777777777';
const LINE2 = '88888888-8888-4888-8888-888888888888';

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe('deadlineToIso', () => {
  it('reads the typed time as Kathmandu time (+05:45), never the server zone', () => {
    expect(deadlineToIso('2030-12-01T17:30')).toBe('2030-12-01T17:30:00+05:45');
  });
  it('refuses text that is not a date and time', () => {
    expect(deadlineToIso('')).toBeNull();
    expect(deadlineToIso('2026-12-01')).toBeNull();
    expect(deadlineToIso('2026-13-45T10:00')).toBeNull();
  });
});

describe('parseRfqValues', () => {
  it('builds the contract body with distinct vendors', () => {
    const v = rfqValuesFromForm(
      form([
        ['purchaseRequestId', PR],
        ['deadline', '2030-12-01T17:30'],
        ['vendorIds', V1],
        ['vendorIds', V2],
        ['vendorIds', V1],
      ]),
    );
    const out = parseRfqValues(v);
    expect(out).toEqual({
      ok: true,
      data: {
        purchaseRequestId: PR,
        deadline: '2030-12-01T17:30:00+05:45',
        vendorIds: [V1, V2],
      },
    });
  });

  it.each([
    ['a past deadline', '2020-01-01T17:00'],
    ['a deadline of exactly now (17:00 Kathmandu)', '2026-11-19T17:00'],
  ])('refuses %s next to the deadline field (I-28)', (_label, deadline) => {
    const now = new Date('2026-11-19T11:15:00Z'); // 17:00 in Kathmandu
    const out = parseRfqValues(
      rfqValuesFromForm(
        form([
          ['purchaseRequestId', PR],
          ['deadline', deadline],
          ['vendorIds', V1],
        ]),
      ),
      now,
    );
    expect(out).toEqual({
      ok: false,
      errors: {
        deadline: 'The quotation deadline has passed. Choose a date and time in the future.',
      },
    });
  });

  it('takes a deadline a minute after now, read in Kathmandu time (I-28)', () => {
    const now = new Date('2026-11-19T11:15:00Z');
    const out = parseRfqValues(
      rfqValuesFromForm(
        form([
          ['purchaseRequestId', PR],
          ['deadline', '2026-11-19T17:01'],
          ['vendorIds', V1],
        ]),
      ),
      now,
    );
    expect(out.ok).toBe(true);
  });

  it('names what is missing in words', () => {
    const out = parseRfqValues(rfqValuesFromForm(form([])));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.purchaseRequestId).toMatch(/purchase request/i);
      expect(out.errors.deadline).toMatch(/deadline/i);
      expect(out.errors.vendorIds).toMatch(/at least one vendor/i);
    }
  });
});

const quoteForm = (extra: [string, string][] = []): FormData =>
  form([
    ['mode', 'record'],
    ['vendorId', V1],
    ['documentId', DOC],
    ['currency', 'NPR'],
    ['lines.0.prLineId', LINE1],
    ['lines.0.include', 'on'],
    ['lines.0.quantity', '10'],
    ['lines.0.unitPrice', '450000.00'],
    ['lines.0.taxCodeId', TAX],
    ['lines.1.prLineId', LINE2],
    ['lines.1.quantity', '5'],
    ['lines.1.unitPrice', ''],
    ['lines.1.taxCodeId', ''],
    ...extra,
  ]);

describe('parseQuoteValues', () => {
  it('sends only the lines that are ticked and leaves empty optional fields out', () => {
    const out = parseQuoteValues(quoteValuesFromForm(quoteForm()));
    expect(out).toEqual({
      ok: true,
      mode: 'record',
      data: {
        vendorId: V1,
        documentId: DOC,
        currency: 'NPR',
        lines: [{ prLineId: LINE1, quantity: '10', unitPrice: '450000.00', taxCodeId: TAX }],
      },
    });
  });

  it('adds the optional fields only when they were typed, and delivery days as a number', () => {
    const out = parseQuoteValues(
      quoteValuesFromForm(
        quoteForm([
          ['vendorRef', ' Q-77 '],
          ['validUntil', '2026-12-31'],
          ['deliveryDays', '14'],
          ['warranty', '1 year'],
          ['terms', 'Net 30'],
        ]),
      ),
    );
    expect(out.ok && out.data).toMatchObject({
      vendorRef: 'Q-77',
      validUntil: '2026-12-31',
      deliveryDays: 14,
      warranty: '1 year',
      terms: 'Net 30',
    });
  });

  it("sends the terms editor's HTML as it is, trimmed, and nothing for an empty editor", () => {
    const html = '<p>Pay <strong>30</strong> days</p><ul><li>Net</li></ul>';
    const sent = parseQuoteValues(quoteValuesFromForm(quoteForm([['terms', `  ${html}\n`]])));
    expect(sent.ok && sent.data).toMatchObject({ terms: html });

    for (const empty of ['', '   ', '<p></p>']) {
      const out = parseQuoteValues(quoteValuesFromForm(quoteForm([['terms', empty]])));
      expect(out.ok && out.data).not.toHaveProperty('terms');
    }
  });

  it('counts the 2000-character limit on the words of the terms, not on the markup', () => {
    const within = `<p><strong>${'x'.repeat(2000)}</strong></p>`;
    expect(parseQuoteValues(quoteValuesFromForm(quoteForm([['terms', within]]))).ok).toBe(true);

    const over = parseQuoteValues(
      quoteValuesFromForm(quoteForm([['terms', `<p><em>${'x'.repeat(2001)}</em></p>`]])),
    );
    expect(over).toEqual({
      ok: false,
      errors: { terms: 'The terms can be up to 2000 characters.' },
    });
  });

  it('convert mode sends the submission and never a vendor or a document', () => {
    const v = quoteValuesFromForm(quoteForm([['submissionId', SUB]]));
    const out = parseQuoteValues({ ...v, mode: 'convert' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toHaveProperty('submissionId', SUB);
      expect(out.data).not.toHaveProperty('vendorId');
      expect(out.data).not.toHaveProperty('documentId');
    }
  });

  it('puts a line error on the line as it appears on screen, not its place among the ticked ones', () => {
    const v: QuoteValues = quoteValuesFromForm(quoteForm());
    v.lines[0]!.include = false;
    v.lines[1]!.include = true;
    v.lines[1]!.unitPrice = '12.345';
    v.lines[1]!.taxCodeId = TAX;
    const out = parseQuoteValues(v);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors['lines.1.unitPrice']).toMatch(/2 decimal places/);
      expect(out.errors['lines.0.unitPrice']).toBeUndefined();
    }
  });

  it('asks for at least one line, a vendor and a document in record mode', () => {
    const v = emptyQuoteValues('record', []);
    const out = parseQuoteValues(v);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.lines).toMatch(/at least one line/i);
      expect(out.errors.vendorId).toBeDefined();
      expect(out.errors.documentId).toBe('Upload the vendor’s quotation document.');
    }
  });

  it('refuses delivery days that are not a whole number', () => {
    const out = parseQuoteValues(quoteValuesFromForm(quoteForm([['deliveryDays', '2.5']])));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.deliveryDays).toMatch(/whole number/i);
  });

  it('says "Remove the space" for a number typed with a space inside, and keeps the other words', () => {
    const v = quoteValuesFromForm(quoteForm([['deliveryDays', '1 5']]));
    v.lines[0]!.quantity = '10 50';
    v.lines[0]!.unitPrice = '1 250 000';
    v.lines[1]!.include = true;
    v.lines[1]!.unitPrice = '12.345';
    v.lines[1]!.taxCodeId = TAX;
    const out = parseQuoteValues(v);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.deliveryDays).toBe('Remove the space inside the number.');
      expect(out.errors['lines.0.quantity']).toBe('Remove the space inside the number.');
      expect(out.errors['lines.0.unitPrice']).toBe('Remove the space inside the number.');
      expect(out.errors['lines.1.unitPrice']).toMatch(/2 decimal places/);
    }
  });
});

describe('scores', () => {
  const errorsOf = (r: ReturnType<typeof parseScoreValues>): Record<string, string> =>
    r.ok ? {} : r.errors;
  const rows = (...r: [string, string][]) =>
    form([
      ...r.flatMap(
        ([c, v], i) =>
          [
            [`scores.${i}.criterion`, c],
            [`scores.${i}.score`, v],
          ] as [string, string][],
      ),
    ]);

  it('reads rows in index order and sends numbers, with no comment', () => {
    const v = scoreValuesFromForm(rows(['Price', '80'], ['Delivery', '72.5']));
    expect(parseScoreValues(v)).toEqual({
      ok: true,
      data: {
        scores: [
          { criterion: 'Price', score: 80 },
          { criterion: 'Delivery', score: 72.5 },
        ],
      },
    });
  });

  it('skips a row left completely blank and keeps the on-screen index in errors', () => {
    const v = scoreValuesFromForm(rows(['', ''], ['Price', 'abc']));
    const r = parseScoreValues(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['scores.1.score']);
  });

  it('asks for at least one scored criterion', () => {
    const r = parseScoreValues(scoreValuesFromForm(rows(['', ''])));
    expect(errorsOf(r).scores).toMatch(/at least one/i);
  });

  it.each(['', '  ', '101', '-1', '1e2', '80.123', '8 0'])('refuses the score %j', (bad) => {
    const r = parseScoreValues(scoreValuesFromForm(rows(['Price', bad])));
    expect(r.ok).toBe(false);
  });

  it('says "Remove the space" for a score typed with a space inside', () => {
    const spaced = parseScoreValues(scoreValuesFromForm(rows(['Price', '8 0'])));
    expect(errorsOf(spaced)['scores.0.score']).toBe('Remove the space inside the number.');
    const over = parseScoreValues(scoreValuesFromForm(rows(['Price', '101'])));
    expect(errorsOf(over)['scores.0.score']).toMatch(/0 to 100/);
  });

  it.each(['0', '100', '100.00', '0.5'])('accepts the score %j', (good) => {
    expect(parseScoreValues(scoreValuesFromForm(rows(['Price', good]))).ok).toBe(true);
  });

  it('refuses a score without a criterion, a long criterion and a repeated one', () => {
    const noName = parseScoreValues(scoreValuesFromForm(rows(['', '50'])));
    expect(errorsOf(noName)['scores.0.criterion']).toBeTruthy();
    const long = parseScoreValues(scoreValuesFromForm(rows(['x'.repeat(65), '50'])));
    expect(errorsOf(long)['scores.0.criterion']).toBeTruthy();
    const dup = parseScoreValues(scoreValuesFromForm(rows(['Price', '50'], [' price ', '60'])));
    expect(errorsOf(dup)['scores.1.criterion']).toMatch(/once/i);
  });

  it('refuses more than 20 rows', () => {
    const many = rows(...Array.from({ length: 21 }, (_, i): [string, string] => [`C${i}`, '50']));
    expect(parseScoreValues(scoreValuesFromForm(many)).ok).toBe(false);
  });
});

describe('recommendation', () => {
  const Q = '99999999-9999-4999-8999-999999999999';
  const base: [string, string][] = [
    ['vendorQuotationId', Q],
    ['rationale', ' Lowest total and the best warranty. '],
  ];

  it('sends the quotation and trimmed rationale and omits a blank reason', () => {
    const r = parseRecommendValues(
      recommendValuesFromForm(form([...base, ['fewerThanThreeReason', '  ']])),
    );
    expect(r).toEqual({
      ok: true,
      data: { vendorQuotationId: Q, rationale: 'Lowest total and the best warranty.' },
    });
  });

  it('carries the reason when one is given', () => {
    const r = parseRecommendValues(
      recommendValuesFromForm(
        form([...base, ['fewerThanThreeReason', 'Only two vendors stock it.']]),
      ),
    );
    expect(r).toMatchObject({
      ok: true,
      data: { fewerThanThreeReason: 'Only two vendors stock it.' },
    });
  });

  it('needs a quotation and a rationale, and words the reason limit', () => {
    const r = parseRecommendValues(
      recommendValuesFromForm(
        form([
          ['rationale', ''],
          ['fewerThanThreeReason', 'x'.repeat(1001)],
        ]),
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual([
        'fewerThanThreeReason',
        'rationale',
        'vendorQuotationId',
      ]);
      expect(r.errors.fewerThanThreeReason).toMatch(/1000/);
    }
  });
});

describe('the deadline extension (F1-Q47)', () => {
  const now = new Date('2026-11-21T00:00:00Z');
  const current = '2026-11-20T04:15:00.000Z';

  it('shows an instant as Kathmandu datetime-local text', () => {
    expect(isoToKathmanduLocal(current)).toBe('2026-11-20T10:00');
    expect(isoToKathmanduLocal('2026-11-30T18:30:00.000Z')).toBe('2026-12-01T00:15');
    expect(isoToKathmanduLocal('not a date')).toBe('');
  });

  it('sends a later Kathmandu deadline with its offset', () => {
    expect(parseExtensionValues('2026-11-25T17:30', current, now)).toEqual({
      ok: true,
      data: { deadline: '2026-11-25T17:30:00+05:45' },
    });
  });

  it('refuses a missing or unreal time, a past one and one not after the current deadline', () => {
    expect(parseExtensionValues('', current, now)).toMatchObject({ ok: false });
    expect(parseExtensionValues('2026-02-30T10:00', current, now)).toMatchObject({ ok: false });
    expect(parseExtensionValues('2026-11-21T05:45', current, now)).toEqual({
      ok: false,
      errors: { deadline: DEADLINE_IN_PAST },
    });
    const future = '2026-12-10T04:15:00.000Z';
    expect(parseExtensionValues('2026-12-10T10:00', future, now)).toEqual({
      ok: false,
      errors: { deadline: DEADLINE_NOT_LATER },
    });
    expect(parseExtensionValues('2026-12-10T10:01', future, now)).toMatchObject({ ok: true });
  });
});

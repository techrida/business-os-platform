import { describe, expect, it } from 'vitest';
import { amountInWords, NUMBER_SYSTEMS, type NumberSystem } from './number-words.js';

const sa = (amount: string): string => amountInWords(amount, 'NPR', 'south_asian');
const intl = (amount: string): string => amountInWords(amount, 'NPR', 'international');

describe('NUMBER_SYSTEMS', () => {
  it('lists both systems', () => {
    expect([...NUMBER_SYSTEMS]).toEqual(['south_asian', 'international']);
  });
});

describe('amountInWords: shared basics (both systems)', () => {
  it.each(NUMBER_SYSTEMS)('spells zero (%s)', (system: NumberSystem) => {
    expect(amountInWords('0', 'NPR', system)).toBe('Zero Rupees Only');
    expect(amountInWords('0.00', 'NPR', system)).toBe('Zero Rupees Only');
  });

  it.each(NUMBER_SYSTEMS)('uses the singular for exactly one (%s)', (system: NumberSystem) => {
    expect(amountInWords('1', 'NPR', system)).toBe('One Rupee Only');
    expect(amountInWords('1.00', 'NPR', system)).toBe('One Rupee Only');
    expect(amountInWords('0.01', 'NPR', system)).toBe('One Paisa Only');
    expect(amountInWords('1.01', 'NPR', system)).toBe('One Rupee And One Paisa Only');
  });

  it.each(NUMBER_SYSTEMS)('keeps the plural for 21, 101 and 2 (%s)', (system: NumberSystem) => {
    expect(amountInWords('21', 'NPR', system)).toBe('Twenty One Rupees Only');
    expect(amountInWords('101', 'NPR', system)).toBe('One Hundred One Rupees Only');
    expect(amountInWords('2', 'NPR', system)).toBe('Two Rupees Only');
  });

  it.each(NUMBER_SYSTEMS)('spells 2..9 and 10 (%s)', (system: NumberSystem) => {
    const words = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    words.forEach((word, i) => {
      expect(amountInWords(String(i + 2), 'NPR', system)).toBe(`${word} Rupees Only`);
    });
    expect(amountInWords('10', 'NPR', system)).toBe('Ten Rupees Only');
  });

  it.each(NUMBER_SYSTEMS)('spells 11 to 19 (%s)', (system: NumberSystem) => {
    const expected: Record<string, string> = {
      '11': 'Eleven',
      '12': 'Twelve',
      '13': 'Thirteen',
      '14': 'Fourteen',
      '15': 'Fifteen',
      '16': 'Sixteen',
      '17': 'Seventeen',
      '18': 'Eighteen',
      '19': 'Nineteen',
    };
    for (const [n, words] of Object.entries(expected)) {
      expect(amountInWords(n, 'NPR', system)).toBe(`${words} Rupees Only`);
    }
  });

  it.each(NUMBER_SYSTEMS)(
    'spells every tens word, with and without units (%s)',
    (system: NumberSystem) => {
      const tens: Record<string, string> = {
        '20': 'Twenty',
        '30': 'Thirty',
        '40': 'Forty',
        '50': 'Fifty',
        '60': 'Sixty',
        '70': 'Seventy',
        '80': 'Eighty',
        '90': 'Ninety',
      };
      for (const [n, words] of Object.entries(tens)) {
        expect(amountInWords(n, 'NPR', system)).toBe(`${words} Rupees Only`);
        expect(amountInWords(String(Number(n) + 7), 'NPR', system)).toBe(
          `${words} Seven Rupees Only`,
        );
      }
      expect(amountInWords('99', 'NPR', system)).toBe('Ninety Nine Rupees Only');
    },
  );

  it.each(NUMBER_SYSTEMS)(
    'spells hundreds without "and" or hyphens (%s)',
    (system: NumberSystem) => {
      expect(amountInWords('100', 'NPR', system)).toBe('One Hundred Rupees Only');
      expect(amountInWords('101', 'NPR', system)).toBe('One Hundred One Rupees Only');
      expect(amountInWords('110', 'NPR', system)).toBe('One Hundred Ten Rupees Only');
      expect(amountInWords('119', 'NPR', system)).toBe('One Hundred Nineteen Rupees Only');
      expect(amountInWords('120', 'NPR', system)).toBe('One Hundred Twenty Rupees Only');
      expect(amountInWords('342', 'NPR', system)).toBe('Three Hundred Forty Two Rupees Only');
      expect(amountInWords('999', 'NPR', system)).toBe('Nine Hundred Ninety Nine Rupees Only');
    },
  );

  it.each(NUMBER_SYSTEMS)('spells one thousand and its neighbours (%s)', (system: NumberSystem) => {
    expect(amountInWords('999', 'NPR', system)).toBe('Nine Hundred Ninety Nine Rupees Only');
    expect(amountInWords('1000', 'NPR', system)).toBe('One Thousand Rupees Only');
    expect(amountInWords('1001', 'NPR', system)).toBe('One Thousand One Rupees Only');
    expect(amountInWords('1100', 'NPR', system)).toBe('One Thousand One Hundred Rupees Only');
    expect(amountInWords('10000', 'NPR', system)).toBe('Ten Thousand Rupees Only');
    expect(amountInWords('99999', 'NPR', system)).toBe(
      'Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
  });

  it.each(NUMBER_SYSTEMS)('puts no zero-valued unit in the middle (%s)', (system: NumberSystem) => {
    expect(amountInWords('1000001', 'NPR', system)).toBe(
      system === 'south_asian' ? 'Ten Lakh One Rupees Only' : 'One Million One Rupees Only',
    );
  });

  it.each(NUMBER_SYSTEMS)(
    'spells paisa on their own and with rupees (%s)',
    (system: NumberSystem) => {
      expect(amountInWords('0.50', 'NPR', system)).toBe('Fifty Paisa Only');
      expect(amountInWords('0.5', 'NPR', system)).toBe('Fifty Paisa Only');
      expect(amountInWords('0.99', 'NPR', system)).toBe('Ninety Nine Paisa Only');
      expect(amountInWords('0.10', 'NPR', system)).toBe('Ten Paisa Only');
      expect(amountInWords('0.19', 'NPR', system)).toBe('Nineteen Paisa Only');
      expect(amountInWords('5.50', 'NPR', system)).toBe('Five Rupees And Fifty Paisa Only');
      expect(amountInWords('100.07', 'NPR', system)).toBe(
        'One Hundred Rupees And Seven Paisa Only',
      );
    },
  );

  it.each(NUMBER_SYSTEMS)('prefixes negatives with Minus (%s)', (system: NumberSystem) => {
    expect(amountInWords('-1', 'NPR', system)).toBe('Minus One Rupee Only');
    expect(amountInWords('-1234.56', 'USD', system)).toBe(
      'Minus One Thousand Two Hundred Thirty Four Dollars And Fifty Six Cents Only',
    );
    expect(amountInWords('-0.50', 'NPR', system)).toBe('Minus Fifty Paisa Only');
    expect(amountInWords('-0.01', 'NPR', system)).toBe('Minus One Paisa Only');
  });

  it.each(NUMBER_SYSTEMS)(
    'never says "Minus Zero" for a rounded-away negative (%s)',
    (system: NumberSystem) => {
      expect(amountInWords('-0', 'NPR', system)).toBe('Zero Rupees Only');
      expect(amountInWords('-0.004', 'NPR', system)).toBe('Zero Rupees Only');
      expect(amountInWords('-0.005', 'NPR', system)).toBe('Minus One Paisa Only');
    },
  );

  it.each(NUMBER_SYSTEMS)(
    'rejects non-finite input with RangeError (%s)',
    (system: NumberSystem) => {
      expect(() => amountInWords('Infinity', 'NPR', system)).toThrow(RangeError);
      expect(() => amountInWords('-Infinity', 'NPR', system)).toThrow(RangeError);
      expect(() => amountInWords('NaN', 'NPR', system)).toThrow(RangeError);
    },
  );

  it('rejects text that is not a decimal', () => {
    expect(() => sa('abc')).toThrow();
    expect(() => intl('')).toThrow();
  });
});

describe('amountInWords: south_asian (lakh, crore, arab, kharab, neel, padma, shankh)', () => {
  it('spells the reference amount', () => {
    expect(sa('2018180')).toBe('Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only');
    expect(sa('2018180.50')).toBe(
      'Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees And Fifty Paisa Only',
    );
  });

  it('spells the lakh boundary', () => {
    expect(sa('99999')).toBe('Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only');
    expect(sa('100000')).toBe('One Lakh Rupees Only');
    expect(sa('100001')).toBe('One Lakh One Rupees Only');
    expect(sa('150000')).toBe('One Lakh Fifty Thousand Rupees Only');
    expect(sa('9999999')).toBe(
      'Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
  });

  it('spells the crore boundary', () => {
    expect(sa('10000000')).toBe('One Crore Rupees Only');
    expect(sa('10000001')).toBe('One Crore One Rupees Only');
    expect(sa('12345678')).toBe(
      'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only',
    );
    expect(sa('999999999')).toBe(
      'Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
  });

  it('spells 1e9 as one arab, not a billion', () => {
    expect(sa('1000000000')).toBe('One Arab Rupees Only');
    expect(sa('1000000000')).not.toContain('Billion');
    expect(sa('1500000000')).toBe('One Arab Fifty Crore Rupees Only');
  });

  it('spells the 1e12 boundary', () => {
    expect(sa('99999999999')).toBe(
      'Ninety Nine Arab Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
    expect(sa('100000000000')).toBe('One Kharab Rupees Only');
    expect(sa('999999999999')).toBe(
      'Nine Kharab Ninety Nine Arab Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
    expect(sa('1000000000000')).toBe('Ten Kharab Rupees Only');
  });

  it('continues the series above kharab', () => {
    expect(sa('10000000000000')).toBe('One Neel Rupees Only');
    expect(sa('1000000000000000')).toBe('One Padma Rupees Only');
    expect(sa('100000000000000000')).toBe('One Shankh Rupees Only');
  });

  it('spells the top unit with an unbounded multiplier', () => {
    expect(sa('100000000000000000000')).toBe('One Thousand Shankh Rupees Only');
    expect(sa('123456700000000000000000')).toBe(
      'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Shankh Rupees Only',
    );
  });

  it('spells a value above 2^53 exactly, with paisa', () => {
    expect(sa('12345678901234567890.12')).toBe(
      'One Hundred Twenty Three Shankh Forty Five Padma Sixty Seven Neel Eighty Nine Kharab One Arab ' +
        'Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety Rupees And Twelve Paisa Only',
    );
    // 2^53 + 1 would round to 2^53 in a float.
    expect(sa('9007199254740993')).toBe(
      'Nine Padma Seventy One Kharab Ninety Nine Arab Twenty Five Crore Forty Seven Lakh Forty Thousand Nine Hundred Ninety Three Rupees Only',
    );
  });

  it('rounds half up to 2 places', () => {
    expect(sa('0.005')).toBe('One Paisa Only');
    expect(sa('0.004')).toBe('Zero Rupees Only');
    expect(sa('0.994')).toBe('Ninety Nine Paisa Only');
    expect(sa('0.995')).toBe('One Rupee Only');
    expect(sa('1.994')).toBe('One Rupee And Ninety Nine Paisa Only');
    expect(sa('99999.995')).toBe('One Lakh Rupees Only');
    expect(sa('999999.995')).toBe('Ten Lakh Rupees Only');
    expect(sa('9999999.995')).toBe('One Crore Rupees Only');
    expect(sa('999999.994')).toBe(
      'Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees And Ninety Nine Paisa Only',
    );
  });

  it('spells INR like NPR', () => {
    expect(amountInWords('2018180.50', 'INR', 'south_asian')).toBe(
      'Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees And Fifty Paisa Only',
    );
    expect(amountInWords('1', 'INR', 'south_asian')).toBe('One Rupee Only');
    expect(amountInWords('0.01', 'INR', 'south_asian')).toBe('One Paisa Only');
  });

  it('spells USD with dollars and cents', () => {
    expect(amountInWords('2018180.50', 'USD', 'south_asian')).toBe(
      'Twenty Lakh Eighteen Thousand One Hundred Eighty Dollars And Fifty Cents Only',
    );
    expect(amountInWords('1', 'USD', 'south_asian')).toBe('One Dollar Only');
    expect(amountInWords('0.01', 'USD', 'south_asian')).toBe('One Cent Only');
    expect(amountInWords('0.50', 'USD', 'south_asian')).toBe('Fifty Cents Only');
    expect(amountInWords('0', 'USD', 'south_asian')).toBe('Zero Dollars Only');
  });
});

describe('amountInWords: international (thousand, million, billion, trillion, quadrillion, quintillion)', () => {
  it('spells the same reference amount in millions', () => {
    expect(intl('2018180')).toBe('Two Million Eighteen Thousand One Hundred Eighty Rupees Only');
    expect(amountInWords('2018180.50', 'USD', 'international')).toBe(
      'Two Million Eighteen Thousand One Hundred Eighty Dollars And Fifty Cents Only',
    );
  });

  it('has no lakh or crore', () => {
    expect(intl('100000')).toBe('One Hundred Thousand Rupees Only');
    expect(intl('9999999')).toBe(
      'Nine Million Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
    expect(intl('10000000')).toBe('Ten Million Rupees Only');
    expect(intl('10000000')).not.toContain('Crore');
  });

  it('spells the million and billion boundaries', () => {
    expect(intl('999999')).toBe(
      'Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
    expect(intl('1000000')).toBe('One Million Rupees Only');
    expect(intl('999999999')).toBe(
      'Nine Hundred Ninety Nine Million Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
    expect(intl('1000000000')).toBe('One Billion Rupees Only');
    expect(intl('1000000001')).toBe('One Billion One Rupees Only');
  });

  it('spells the 1e12 boundary', () => {
    expect(intl('999999999999')).toBe(
      'Nine Hundred Ninety Nine Billion Nine Hundred Ninety Nine Million Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine Rupees Only',
    );
    expect(intl('1000000000000')).toBe('One Trillion Rupees Only');
  });

  it('continues the series', () => {
    expect(intl('1000000000000000')).toBe('One Quadrillion Rupees Only');
    expect(intl('1000000000000000000')).toBe('One Quintillion Rupees Only');
  });

  it('spells the top unit with an unbounded multiplier', () => {
    expect(intl('1000000000000000000000')).toBe('One Thousand Quintillion Rupees Only');
  });

  it('spells a value above 2^53 exactly, with cents', () => {
    expect(amountInWords('12345678901234567890.12', 'USD', 'international')).toBe(
      'Twelve Quintillion Three Hundred Forty Five Quadrillion Six Hundred Seventy Eight Trillion ' +
        'Nine Hundred One Billion Two Hundred Thirty Four Million Five Hundred Sixty Seven Thousand ' +
        'Eight Hundred Ninety Dollars And Twelve Cents Only',
    );
    expect(intl('9007199254740993')).toBe(
      'Nine Quadrillion Seven Trillion One Hundred Ninety Nine Billion Two Hundred Fifty Four Million Seven Hundred Forty Thousand Nine Hundred Ninety Three Rupees Only',
    );
  });

  it('rounds half up to 2 places and rolls over into the next unit', () => {
    expect(intl('0.005')).toBe('One Paisa Only');
    expect(intl('0.994')).toBe('Ninety Nine Paisa Only');
    expect(intl('999999.995')).toBe('One Million Rupees Only');
    expect(intl('999999999.995')).toBe('One Billion Rupees Only');
    expect(intl('999999.994')).toBe(
      'Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine Rupees And Ninety Nine Paisa Only',
    );
  });

  it('spells USD singular and plural', () => {
    expect(amountInWords('1', 'USD', 'international')).toBe('One Dollar Only');
    expect(amountInWords('1.01', 'USD', 'international')).toBe('One Dollar And One Cent Only');
    expect(amountInWords('2.02', 'USD', 'international')).toBe('Two Dollars And Two Cents Only');
    expect(amountInWords('0.50', 'USD', 'international')).toBe('Fifty Cents Only');
  });

  it('spells INR with paisa', () => {
    expect(amountInWords('1000000.01', 'INR', 'international')).toBe(
      'One Million Rupees And One Paisa Only',
    );
  });
});

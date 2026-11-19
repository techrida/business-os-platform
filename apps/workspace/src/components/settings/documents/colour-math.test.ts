import { PRESET_BRAND_COLOURS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { contrastWords, hexToHsv, hsvToHex, normalizeHex, type Hsv } from './colour-math';

function hsv(hex: string): Hsv {
  const value = hexToHsv(hex);
  if (!value) throw new Error(`Not a hex colour: ${hex}`);
  return value;
}

describe('normalizeHex', () => {
  it('accepts with or without the hash, any case, and trims', () => {
    expect(normalizeHex('#1D4ED8')).toBe('#1d4ed8');
    expect(normalizeHex('1d4ed8')).toBe('#1d4ed8');
    expect(normalizeHex('  #AbCdEf  ')).toBe('#abcdef');
  });

  it('expands 3-digit shorthand', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('F80')).toBe('#ff8800');
  });

  it.each([
    '',
    '#',
    '#12',
    '#1234',
    '#12345',
    '#1234567',
    'ggg',
    '#gggggg',
    '##123456',
    '12 34 56',
    'rgb(1,2,3)',
  ])('returns null for %j', (text) => {
    expect(normalizeHex(text)).toBeNull();
  });
});

describe('hexToHsv', () => {
  it('reads the primaries', () => {
    expect(hsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 });
    expect(hsv('#0000ff')).toEqual({ h: 240, s: 1, v: 1 });
  });

  it('reads black, white and grey as unsaturated with hue 0', () => {
    expect(hsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 });
    const grey = hsv('#808080');
    expect(grey.h).toBe(0);
    expect(grey.s).toBe(0);
    expect(grey.v).toBeCloseTo(128 / 255, 10);
  });

  it('keeps hue just below 360 instead of wrapping to 0', () => {
    const { h } = hsv('#ff0001');
    expect(h).toBeGreaterThan(359);
    expect(h).toBeLessThan(360);
  });

  it('accepts what normalizeHex accepts and returns null otherwise', () => {
    expect(hexToHsv('f00')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('nope')).toBeNull();
    expect(hexToHsv('')).toBeNull();
  });
});

describe('hsvToHex', () => {
  it('writes the primaries, black and white', () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe('#00ff00');
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe('#0000ff');
    expect(hsvToHex({ h: 200, s: 0.5, v: 0 })).toBe('#000000');
    expect(hsvToHex({ h: 200, s: 0, v: 1 })).toBe('#ffffff');
  });

  it('ignores hue when saturation is 0, so a grey keeps its hue in state', () => {
    expect(hsvToHex({ h: 10, s: 0, v: 0.5 })).toBe(hsvToHex({ h: 300, s: 0, v: 0.5 }));
  });

  it('wraps hue 360 to red and negative hue to the matching colour', () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe('#0000ff');
    expect(hsvToHex({ h: 720, s: 1, v: 1 })).toBe('#ff0000');
  });

  it('clamps out-of-range saturation and value', () => {
    expect(hsvToHex({ h: 0, s: 5, v: 5 })).toBe('#ff0000');
    expect(hsvToHex({ h: 0, s: -1, v: -1 })).toBe('#000000');
  });

  it('always writes lowercase #rrggbb', () => {
    for (let h = 0; h < 360; h += 7) {
      expect(hsvToHex({ h, s: 0.73, v: 0.91 })).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('round trips', () => {
  const colours = [
    ...PRESET_BRAND_COLOURS.map((preset) => preset.hex),
    '#808080',
    '#000000',
    '#ffffff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#ff0001',
    '#ff0004',
    '#fe0001',
    '#010000',
    '#fffffe',
  ];

  it.each(colours)('hex to HSV to hex gives back %s', (hex) => {
    expect(hsvToHex(hsv(hex))).toBe(hex);
  });

  it('is exact for every channel step of a sampled grid', () => {
    for (let r = 0; r < 256; r += 51) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 85) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
          expect(hsvToHex(hsv(hex))).toBe(hex);
        }
      }
    }
  });
});

describe('contrastWords', () => {
  it('names the three bands at their boundaries', () => {
    expect(contrastWords(21)).toBe('Excellent contrast');
    expect(contrastWords(7)).toBe('Excellent contrast');
    expect(contrastWords(6.99)).toBe('Good contrast');
    expect(contrastWords(4.5)).toBe('Good contrast');
    expect(contrastWords(4.49)).toBe('Low contrast');
    expect(contrastWords(1)).toBe('Low contrast');
  });
});

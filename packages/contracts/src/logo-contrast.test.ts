import { describe, expect, it } from 'vitest';

import { relativeLuminance } from './document-style.js';
import {
  backgroundKind,
  chooseLogo,
  luminanceContrast,
  MIN_LOGO_CONTRAST,
  type LogoSet,
  type LogoStats,
} from './logo-contrast.js';

const dark: LogoStats = { luminance: 0.01, hasTransparency: true };
const light: LogoStats = { luminance: 0.95, hasTransparency: true };
const opaqueDark: LogoStats = { luminance: 0.01, hasTransparency: false };
const none: Pick<LogoSet, 'forDark' | 'forLight'> = { forDark: null, forLight: null };
const BLUE = relativeLuminance('#1d4ed8');
const WHITE = 1;
const NEAR_BLACK = relativeLuminance('#0a0a0a');

describe('background kind', () => {
  it('splits at the point where white and black text contrast equally, not at 0.5', () => {
    expect(backgroundKind(BLUE)).toBe('dark');
    expect(backgroundKind(relativeLuminance('#6e6e6e'))).toBe('dark');
    expect(backgroundKind(relativeLuminance('#8a8a8a'))).toBe('light');
    expect(backgroundKind(WHITE)).toBe('light');
  });
});

describe('chooseLogo', () => {
  it('keeps the primary when it reaches 3:1', () => {
    expect(chooseLogo({ primary: dark, ...none }, WHITE)).toEqual({ use: 'primary' });
    expect(chooseLogo({ primary: light, ...none }, NEAR_BLACK)).toEqual({ use: 'primary' });
    expect(luminanceContrast(dark.luminance, WHITE)).toBeGreaterThanOrEqual(MIN_LOGO_CONTRAST);
  });

  it('uses the logo for dark backgrounds when a dark primary lands on blue', () => {
    expect(chooseLogo({ primary: dark, forDark: light, forLight: null }, BLUE)).toEqual({
      use: 'forDark',
    });
  });

  it('uses the logo for light backgrounds when a light primary lands on white', () => {
    expect(chooseLogo({ primary: light, forDark: null, forLight: dark }, WHITE)).toEqual({
      use: 'forLight',
    });
  });

  it('makes a white copy of a transparent dark primary on blue when no variant exists', () => {
    expect(chooseLogo({ primary: dark, ...none }, BLUE)).toEqual({ use: 'mono', colour: 'white' });
  });

  it('makes a black copy of a transparent light primary on white when no variant exists', () => {
    expect(chooseLogo({ primary: light, ...none }, WHITE)).toEqual({
      use: 'mono',
      colour: 'black',
    });
  });

  it('ignores a variant that is itself unreadable (uploaded the wrong way round)', () => {
    expect(chooseLogo({ primary: dark, forDark: dark, forLight: null }, BLUE)).toEqual({
      use: 'mono',
      colour: 'white',
    });
  });

  it('keeps a mid-tone transparent logo on white as uploaded (no black silhouette)', () => {
    const orange: LogoStats = { luminance: 0.4, hasTransparency: true };
    expect(chooseLogo({ primary: orange, ...none }, WHITE)).toEqual({ use: 'primary' });
  });

  it('never plates or recolours an opaque near-white logo on white paper', () => {
    const opaqueLight: LogoStats = { luminance: 0.9, hasTransparency: false };
    expect(chooseLogo({ primary: opaqueLight, ...none }, WHITE)).toEqual({ use: 'primary' });
  });

  it('falls back to a plate for an opaque logo that fails on a dark background and has no variant', () => {
    expect(chooseLogo({ primary: opaqueDark, ...none }, BLUE)).toEqual({ use: 'plate' });
  });

  it('never uses the variant made for the other background kind', () => {
    expect(chooseLogo({ primary: dark, forDark: null, forLight: light }, BLUE)).toEqual({
      use: 'mono',
      colour: 'white',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { contrastRatio } from './document-style.js';
import {
  AVATAR_PALETTE,
  IMAGE_MIME,
  SetImageBodySchema,
  avatarColour,
  avatarInitials,
  isImageOwnerType,
} from './images.js';

describe('avatarColour', () => {
  const id = '3f0c5a52-7c2e-4d0b-9a55-0e8d1d6a3b11';

  it('gives the same colour for the same id every time, whatever its case', () => {
    expect(avatarColour(id)).toBe(avatarColour(id));
    expect(avatarColour(id)).toBe(avatarColour(id.toUpperCase()));
  });

  it('always picks a palette colour and uses most of the palette across many ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const colour = avatarColour(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect(AVATAR_PALETTE).toContain(colour);
      seen.add(colour);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it('falls back to a neutral colour with no id', () => {
    expect(avatarColour(null)).toBe(avatarColour(undefined));
    expect(avatarColour('')).toBe(avatarColour(null));
  });

  it('keeps white initials readable on every palette colour', () => {
    for (const colour of AVATAR_PALETTE) {
      expect(contrastRatio('#ffffff', colour)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('avatarInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(avatarInitials('Asha Karki Sharma')).toBe('AK');
    expect(avatarInitials('  crestia  ')).toBe('C');
    expect(avatarInitials('Ñandú Éclair')).toBe('ÑÉ');
  });
  it('shows a question mark when there is no letter', () => {
    expect(avatarInitials('')).toBe('?');
    expect(avatarInitials(' -- ')).toBe('?');
  });
});

describe('image contracts', () => {
  it('never allows SVG', () => {
    expect(IMAGE_MIME as readonly string[]).not.toContain('image/svg+xml');
  });
  it('knows its owner types', () => {
    expect(isImageOwnerType('user_avatar')).toBe(true);
    expect(isImageOwnerType('quotation')).toBe(false);
  });
  it('takes a document id or null to set an image', () => {
    expect(SetImageBodySchema.safeParse({ documentId: null }).success).toBe(true);
    expect(SetImageBodySchema.safeParse({ documentId: 'nope' }).success).toBe(false);
    expect(SetImageBodySchema.safeParse({ documentId: null, extra: 1 }).success).toBe(false);
  });
});

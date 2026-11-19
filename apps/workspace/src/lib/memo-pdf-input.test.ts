import type { Letterhead } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { MemoPdfInputSchema, memoPdfInputOf } from './memo-pdf-input';

const template = {
  organizationName: 'Crestia',
  departmentName: 'Finance',
  date: '2026-11-12',
  closing: 'Thanks',
  preparedBy: { userId: 'u1', name: 'A', jobTitle: 'T', department: 'D' },
  recommenders: [],
  approvedBy: { userId: 'u3', name: 'C', jobTitle: null, department: null },
};
const PNG_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';
const frozen: Letterhead = {
  addressLines: ['Kathmandu', 'Nepal'],
  logoDataUrl: PNG_URL,
  primaryColour: '#0f766e',
};
const live: Letterhead = { addressLines: ['Pokhara'], logoDataUrl: null, primaryColour: '#be123c' };

describe('memoPdfInputOf letterhead', () => {
  it('carries the letterhead frozen on a saved memo', () => {
    const built = memoPdfInputOf({ ...template, letterhead: frozen }, 'S', 'B');
    expect(built.letterhead).toEqual(frozen);
    expect(MemoPdfInputSchema.parse(built)).toEqual(built);
  });

  it('carries the live directory letterhead the form passes for an unsaved memo', () => {
    expect(memoPdfInputOf(template, 'S', 'B', live).letterhead).toEqual(live);
  });

  it('prefers the frozen letterhead over a live one, so a sent memo never changes', () => {
    expect(memoPdfInputOf({ ...template, letterhead: frozen }, 'S', 'B', live).letterhead).toEqual(
      frozen,
    );
  });

  it('leaves the key out when there is none (a memo stored before letterheads)', () => {
    const built = memoPdfInputOf(template, 'S', 'B');
    expect(built).not.toHaveProperty('letterhead');
    expect(MemoPdfInputSchema.parse(built)).toEqual(built);
  });
});

describe('MemoPdfInputSchema letterhead bounds', () => {
  const body = (letterhead: unknown) => ({
    ...memoPdfInputOf(template, 'S', 'B'),
    letterhead,
  });

  it('accepts a full letterhead: four lines, a PNG logo, a colour', () => {
    const ok = { ...frozen, addressLines: ['a', 'b', 'c', 'd'] };
    expect(MemoPdfInputSchema.safeParse(body(ok)).success).toBe(true);
  });

  it('refuses a fifth address line and a line over 400 characters', () => {
    expect(
      MemoPdfInputSchema.safeParse(body({ ...frozen, addressLines: ['a', 'b', 'c', 'd', 'e'] }))
        .success,
    ).toBe(false);
    expect(
      MemoPdfInputSchema.safeParse(body({ ...frozen, addressLines: ['x'.repeat(401)] })).success,
    ).toBe(false);
  });

  it('refuses an oversize logo and one that is not a PNG, JPEG or WebP data URL', () => {
    const oversize = `data:image/png;base64,${'A'.repeat(720_001)}`;
    expect(MemoPdfInputSchema.safeParse(body({ ...frozen, logoDataUrl: oversize })).success).toBe(
      false,
    );
    for (const bad of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'https://evil.example/logo.png',
      'data:image/png;base64,<script>',
    ]) {
      expect(MemoPdfInputSchema.safeParse(body({ ...frozen, logoDataUrl: bad })).success, bad).toBe(
        false,
      );
    }
  });

  it('refuses a colour that is not a hex colour', () => {
    expect(MemoPdfInputSchema.safeParse(body({ ...frozen, primaryColour: 'red;' })).success).toBe(
      false,
    );
  });
});

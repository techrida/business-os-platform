import { expect, it } from 'vitest';

import { EDGE_MAX_SPEED, edgeScrollDelta } from './board-scroll';

const bounds = { left: 100, right: 1100 };

it('does not scroll while the pointer is away from both edges', () => {
  expect(edgeScrollDelta(600, bounds)).toBe(0);
  expect(edgeScrollDelta(100 + 72, bounds)).toBe(0);
});

it('scrolls left near the left edge and right near the right edge', () => {
  expect(edgeScrollDelta(110, bounds)).toBeLessThan(0);
  expect(edgeScrollDelta(1090, bounds)).toBeGreaterThan(0);
});

it('speeds up the closer the pointer gets, up to the maximum', () => {
  const far = Math.abs(edgeScrollDelta(150, bounds));
  const near = Math.abs(edgeScrollDelta(110, bounds));
  expect(near).toBeGreaterThan(far);
  expect(edgeScrollDelta(100, bounds)).toBe(-EDGE_MAX_SPEED);
  expect(edgeScrollDelta(5000, bounds)).toBe(EDGE_MAX_SPEED);
});

it('always moves at least one pixel inside the zone', () => {
  expect(edgeScrollDelta(100 + 71, bounds)).toBe(-1);
});

it('splits a very narrow board in two instead of scrolling both ways', () => {
  const narrow = { left: 0, right: 100 };
  expect(edgeScrollDelta(20, narrow)).toBeLessThan(0);
  expect(edgeScrollDelta(80, narrow)).toBeGreaterThan(0);
  expect(edgeScrollDelta(50, narrow)).toBe(0);
});

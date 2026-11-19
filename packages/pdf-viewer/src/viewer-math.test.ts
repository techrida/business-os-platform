import { describe, expect, it } from 'vitest';

import {
  MAX_CANVAS_PIXELS,
  MAX_DEVICE_PIXEL_RATIO,
  MAX_ZOOM,
  MIN_ZOOM,
  clampPage,
  clampZoom,
  outputScale,
  pageAtScroll,
  pageScale,
  pagesToRender,
  stepZoom,
} from './viewer-math';

describe('zoom', () => {
  it('clamps to the allowed range and survives non-numbers', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('steps by a quarter, stops at both ends and does not drift', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    let zoom = 1;
    for (let i = 0; i < 8; i += 1) zoom = stepZoom(zoom, 1);
    expect(zoom).toBe(MAX_ZOOM);
  });
});

describe('pageScale', () => {
  it('fits the page width to the available width and multiplies by zoom', () => {
    expect(pageScale(374, 612, 1)).toBeCloseTo(374 / 612, 10);
    expect(pageScale(374, 612, 2)).toBeCloseTo((374 / 612) * 2, 10);
  });

  it('returns 0 for an unmeasured container or page', () => {
    expect(pageScale(0, 612, 1)).toBe(0);
    expect(pageScale(374, 0, 1)).toBe(0);
  });
});

describe('outputScale', () => {
  it('caps the device pixel ratio at 2', () => {
    expect(outputScale(390, 550, 3)).toBe(MAX_DEVICE_PIXEL_RATIO);
    expect(outputScale(390, 550, 1.5)).toBe(1.5);
    expect(outputScale(390, 550, 0)).toBe(1);
  });

  it('lowers the density so a huge page stays under the canvas budget, never below 1', () => {
    const scale = outputScale(3000, 4000, 2);
    expect(scale).toBeLessThan(2);
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(3000 * scale * 4000 * scale).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
    expect(outputScale(20000, 20000, 2)).toBe(1);
  });
});

describe('pagesToRender', () => {
  it('adds one page on each side, sorted, without duplicates', () => {
    expect(pagesToRender([4, 5], 10)).toEqual([3, 4, 5, 6]);
  });

  it('stays inside the document and ignores junk page numbers', () => {
    expect(pagesToRender([1], 5)).toEqual([1, 2]);
    expect(pagesToRender([5], 5)).toEqual([4, 5]);
    expect(pagesToRender([0, 99, 2.5], 5)).toEqual([]);
    expect(pagesToRender([3], 5, 0)).toEqual([3]);
  });
});

describe('clampPage', () => {
  it('keeps the page inside 1..count', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(6, 5)).toBe(5);
    expect(clampPage(3.9, 5)).toBe(3);
    expect(clampPage(2, 0)).toBe(1);
  });
});

describe('pageAtScroll', () => {
  const tops = [0, 600, 1200, 1800];

  it('picks the last page above the one-third line', () => {
    const base = { tops, viewportHeight: 600, scrollHeight: 2400 };
    expect(pageAtScroll({ ...base, scrollTop: 0 })).toBe(1);
    expect(pageAtScroll({ ...base, scrollTop: 399 })).toBe(1);
    expect(pageAtScroll({ ...base, scrollTop: 400 })).toBe(2);
    expect(pageAtScroll({ ...base, scrollTop: 1000 })).toBe(3);
  });

  it('reports the last page at the very bottom even when it is too short to reach the line', () => {
    const short = [0, 600, 1200, 1500];
    expect(
      pageAtScroll({ tops: short, scrollTop: 700, viewportHeight: 800, scrollHeight: 1500 }),
    ).toBe(4);
    expect(
      pageAtScroll({ tops: short, scrollTop: 400, viewportHeight: 800, scrollHeight: 1500 }),
    ).toBe(2);
  });

  it('is page 1 for an empty list', () => {
    expect(pageAtScroll({ tops: [], scrollTop: 0, viewportHeight: 600, scrollHeight: 0 })).toBe(1);
  });
});

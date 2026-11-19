import { describe, expect, it, vi } from 'vitest';

import { setTotalCount, TOTAL_COUNT_HEADER } from './total-count';

describe('setTotalCount', () => {
  it('sets X-Total-Count as text', () => {
    const res = { setHeader: vi.fn() };
    setTotalCount(res, 134);
    expect(res.setHeader).toHaveBeenCalledWith(TOTAL_COUNT_HEADER, '134');
    expect(TOTAL_COUNT_HEADER).toBe('X-Total-Count');
  });

  it('accepts zero and refuses a negative or fractional total', () => {
    const res = { setHeader: vi.fn() };
    setTotalCount(res, 0);
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '0');
    expect(() => setTotalCount(res, -1)).toThrow();
    expect(() => setTotalCount(res, 1.5)).toThrow();
  });
});

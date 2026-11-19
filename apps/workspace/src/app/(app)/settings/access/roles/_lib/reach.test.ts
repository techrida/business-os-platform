import { describe, expect, it } from 'vitest';

import {
  peopleText,
  reachFromValue,
  reachHint,
  reachOptions,
  reachText,
} from './reach';

describe('reachOptions', () => {
  it('offers Nothing plus exactly the reaches the API lists, in spec order', () => {
    expect(reachOptions(['all', 'own', 'department', 'assigned'], null)).toEqual([
      { value: '', label: 'Nothing' },
      { value: 'assigned', label: 'Only work given to them' },
      { value: 'own', label: 'Their own' },
      { value: 'department', label: 'Their department' },
      { value: 'all', label: 'Everything' },
    ]);
  });

  it('never offers a reach the API did not list', () => {
    const labels = reachOptions(['own', 'all'], 'own').map((o) => o.label);
    expect(labels).toEqual(['Nothing', 'Their own', 'Everything']);
    expect(labels).not.toContain('Their department');
    expect(labels).not.toContain('Only work given to them');
  });

  it('keeps a saved reach that is no longer offered visible but not choosable', () => {
    expect(reachOptions(['own', 'all'], 'department')).toContainEqual({
      value: 'department',
      label: 'Their department',
      disabled: true,
    });
  });
});

describe('reach wording', () => {
  it('reads on/off permissions as On and Off, and record ones in words', () => {
    expect(reachText(null, 'onOff')).toBe('Off');
    expect(reachText('all', 'onOff')).toBe('On');
    expect(reachText(null, 'record')).toBe('Nothing');
    expect(reachText('own', 'record')).toBe('Their own');
    expect(reachText('customer_org', 'portal')).toBe("Their own company's records");
  });

  it('explains each reach in one line and never says scope', () => {
    for (const scope of ['assigned', 'own', 'department', 'all', 'customer_org', null] as const) {
      expect(reachHint(scope)).not.toMatch(/scope|grant/i);
    }
    expect(reachHint('assigned')).toBe('Records they were assigned a task on. Read only.');
  });

  it('turns an unknown select value into Nothing', () => {
    expect(reachFromValue('own', ['own', 'all'])).toBe('own');
    expect(reachFromValue('', ['own', 'all'])).toBeNull();
    expect(reachFromValue('department', ['own', 'all'])).toBeNull();
  });

  it('counts people in words', () => {
    expect(peopleText(1)).toBe('1 person');
    expect(peopleText(0)).toBe('0 people');
    expect(peopleText(6)).toBe('6 people');
  });
});

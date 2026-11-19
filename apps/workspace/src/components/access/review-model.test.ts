import type { AccessWarning } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  acknowledgedCodes,
  allConfirmed,
  canSave,
  carryTicks,
  impactSentence,
  sampleNames,
  warningKey,
} from './review-model';

const confirmW5: AccessWarning = {
  code: 'W5',
  severity: 'confirm',
  message: '12 people will see every invoice.',
};
const confirmW7: AccessWarning = {
  code: 'W7',
  severity: 'confirm',
  message: '3 people will no longer be able to open 41 leads they are working on.',
};
const infoW8: AccessWarning = { code: 'W8', severity: 'info', message: 'Sales can still edit.' };
const blockedW1: AccessWarning = {
  code: 'W1',
  severity: 'blocked',
  message: 'Founders always have full access.',
};

describe('who is affected', () => {
  it('names up to three people and counts the rest', () => {
    const bucket = { people: 6, sample: ['Asha K.', 'Bibek R.', 'Chandra T.'] };
    expect(sampleNames(bucket)).toBe('Asha K., Bibek R., Chandra T. and 3 others');
    expect(impactSentence(bucket, 'more')).toBe(
      '6 people will see more: Asha K., Bibek R., Chandra T. and 3 others.',
    );
  });

  it('reads naturally for one, two and nobody', () => {
    expect(impactSentence({ people: 1, sample: ['Asha K.'] }, 'less')).toBe(
      '1 person will see less: Asha K.',
    );
    expect(sampleNames({ people: 2, sample: ['Asha K.', 'Bibek R.'] })).toBe(
      'Asha K. and Bibek R.',
    );
    expect(impactSentence({ people: 0, sample: [] }, 'less')).toBe('No one will see less.');
    expect(impactSentence({ people: 4, sample: [] }, 'more')).toBe('4 people will see more.');
  });
});

describe('save gate', () => {
  const warnings = [confirmW5, infoW8, confirmW7];

  it('needs a successful preview first', () => {
    expect(canSave({ previewed: false, saving: false, warnings: [], ticked: new Set() })).toBe(
      false,
    );
    expect(canSave({ previewed: true, saving: false, warnings: [], ticked: new Set() })).toBe(true);
  });

  it('needs every confirm warning ticked; info warnings need nothing', () => {
    const one = new Set([warningKey(confirmW5, 0)]);
    expect(allConfirmed(warnings, one)).toBe(false);
    expect(canSave({ previewed: true, saving: false, warnings, ticked: one })).toBe(false);
    const both = new Set([warningKey(confirmW5, 0), warningKey(confirmW7, 2)]);
    expect(canSave({ previewed: true, saving: false, warnings, ticked: both })).toBe(true);
  });

  it('never opens with a blocked warning, whatever is ticked', () => {
    const list = [blockedW1, confirmW5];
    const ticked = new Set([warningKey(confirmW5, 1)]);
    expect(canSave({ previewed: true, saving: false, warnings: list, ticked })).toBe(false);
  });

  it('stays shut while a save is in flight', () => {
    expect(canSave({ previewed: true, saving: true, warnings: [], ticked: new Set() })).toBe(false);
  });
});

describe('acknowledged codes', () => {
  it('sends each ticked confirm code once and never an info code', () => {
    const list = [confirmW5, { ...confirmW5, changeIndex: 2 }, infoW8];
    const ticked = new Set(list.map((warning, index) => warningKey(warning, index)));
    expect(acknowledgedCodes(list, ticked)).toEqual(['W5']);
  });

  it('keeps ticks only for codes already acknowledged when the server asks again', () => {
    const next = [confirmW5, confirmW7];
    const ticks = carryTicks(next, ['W5']);
    expect(ticks.has(warningKey(confirmW5, 0))).toBe(true);
    expect(ticks.has(warningKey(confirmW7, 1))).toBe(false);
  });
});

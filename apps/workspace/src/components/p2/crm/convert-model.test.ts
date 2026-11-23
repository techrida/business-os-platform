import { expect, it } from 'vitest';

import {
  customerDescription,
  errorsOfStep,
  firstStepWithError,
  normalizePan,
  panToLookUp,
  stepOfField,
} from './convert-model';

it('places every field the parser reports on its step', () => {
  for (const key of ['customerId', 'legalName', 'panVatNo', 'address.line', 'address.city']) {
    expect(stepOfField(key), key).toBe(0);
  }
  for (const key of [
    'contactId',
    'contactName',
    'contactEmail',
    'contactCountry',
    'contactPhones.1',
  ]) {
    expect(stepOfField(key), key).toBe(1);
  }
  for (const key of ['opportunityName', 'overrideReason', 'expectedVersion']) {
    expect(stepOfField(key), key).toBe(2);
  }
});

it('answers for the current step only and returns to the earliest step with an error', () => {
  const errors = { legalName: 'a', contactEmail: 'b', opportunityName: 'c' };
  expect(errorsOfStep(errors, 1)).toEqual({ contactEmail: 'b' });
  expect(firstStepWithError(errors)).toBe(0);
  expect(firstStepWithError({ opportunityName: 'c' })).toBe(2);
  expect(firstStepWithError({})).toBeNull();
});

it('compares a PAN without spaces, dashes or case, and looks a Nepal PAN up only when complete', () => {
  expect(normalizePan(' 601-234 567 ')).toBe('601234567');
  expect(normalizePan('gb 123')).toBe('GB123');
  expect(panToLookUp('601234567', 'NP')).toBe('601234567');
  expect(panToLookUp('60123456', 'NP')).toBeUndefined();
  expect(panToLookUp('', 'NP')).toBeUndefined();
  expect(panToLookUp('GB 123 456', 'GB')).toBe('GB123456');
  expect(panToLookUp('GB1', 'GB')).toBeUndefined();
});

it('describes a customer by PAN/VAT and number, whichever exist', () => {
  const base = { id: 'x', name: 'Acme', number: 'CUS-0001' };
  expect(customerDescription({ ...base, pan: '601234567' })).toBe('PAN/VAT 601234567 · CUS-0001');
  expect(customerDescription({ ...base, pan: null })).toBe('CUS-0001');
});

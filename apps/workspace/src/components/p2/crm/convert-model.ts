// The pure part of the convert wizard (R6T): which step a field belongs to, which stored customers count as the
// same PAN, and how a customer reads in a list. No React, so every rule is unit-tested.
import type { CountryCode } from '@bos/contracts';

import type { ConversionCustomer } from './record-lookups';

export const CONVERT_STEPS = ['Organisation', 'Contact', 'Deal'] as const;
export type ConvertStep = 0 | 1 | 2;
export const LAST_STEP: ConvertStep = 2;

/** Which step shows a field, by the key the form parser reports it under. */
export function stepOfField(key: string): ConvertStep {
  if (
    key === 'customerId' ||
    key === 'legalName' ||
    key === 'panVatNo' ||
    key.startsWith('address.')
  ) {
    return 0;
  }
  if (key === 'contactId' || key.startsWith('contact')) return 1;
  return 2;
}

/** The field errors a step is answerable for (the rest wait for their own step). */
export function errorsOfStep(
  errors: Partial<Record<string, string>>,
  step: ConvertStep,
): Partial<Record<string, string>> {
  return Object.fromEntries(Object.entries(errors).filter(([key]) => stepOfField(key) === step));
}

/** The earliest step that holds an error, or null. */
export function firstStepWithError(errors: Partial<Record<string, string>>): ConvertStep | null {
  const steps = Object.keys(errors).map(stepOfField);
  return steps.length === 0 ? null : (Math.min(...steps) as ConvertStep);
}

/** A PAN or VAT number as compared: spaces and dashes out, upper case. */
export const normalizePan = (value: string): string => value.replace(/[\s-]+/g, '').toUpperCase();

/**
 * The number worth looking up while it is typed, or undefined. A Nepal PAN is looked up once it has all nine digits
 * (a shorter one cannot be the same number); a foreign tax id once it has a few characters.
 */
export function panToLookUp(value: string, country: CountryCode): string | undefined {
  const key = normalizePan(value);
  if (country === 'NP') return /^\d{9}$/.test(key) ? key : undefined;
  return key.length >= 4 ? key : undefined;
}

/** The muted line under a customer's name in a list: PAN/VAT and customer number, whichever exist. */
export function customerDescription(c: ConversionCustomer): string {
  return [c.pan ? `PAN/VAT ${c.pan}` : null, c.number].filter(Boolean).join(' · ');
}

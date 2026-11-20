'use server';

import {
  ChangeTaxCodeBodySchema,
  CreateTaxCodeBodySchema,
  RetireTaxCodeBodySchema,
  TaxCodeCodeSchema,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { changeTaxCode, createTaxCode, retireTaxCode } from '@/lib/api-master-data';

import { fail, ok, type ActionState } from '../action-state';
import { describeError } from '../admin-errors';
import { requireSection } from '../guard';

// Server Actions of the VAT codes table on Settings > Tax (F1-Q49). Each is its own request, so the section
// permission (settings.finance.write or admin.settings.write) is asked again here, apart from the page; the API
// checks the same grant. Every refusal names the problem in words; a 409 or 404 refreshes the table so the person
// sees what the server holds.

const PATH = '/settings/tax';
const CHECK = 'Check the details and try again.';

function refused(error: unknown): ActionState {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
  if (status === 404 || status === 409) revalidatePath(PATH);
  return fail(describeError(error, 'change tax codes'));
}

const STALE = 'That tax code changed since this page loaded. Reload the page.';

/** The first problem in words; a missing or malformed period id or version means the screen is out of date. */
function firstIssue(issues: readonly { message: string; path: readonly PropertyKey[] }[]): string {
  const issue = issues[0];
  if (issue?.path[0] === 'expectedPeriodId' || issue?.path[0] === 'expectedVersion') return STALE;
  return issue?.message ?? CHECK;
}

export interface TaxCodeInput {
  code: string;
  name: string;
  kind: string;
  rate: string;
  creditable: boolean;
  effectiveFrom: string;
}

export async function addTaxCodeAction(input: TaxCodeInput): Promise<ActionState> {
  const session = await requireSection('tax');
  const parsed = CreateTaxCodeBodySchema.safeParse({ ...input, code: input.code.toUpperCase() });
  if (!parsed.success) return fail(firstIssue(parsed.error.issues));
  try {
    await createTaxCode(session, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok(`Tax code ${parsed.data.code} added.`);
}

export interface TaxCodeChangeInput {
  name: string;
  rate: string;
  creditable: boolean;
  effectiveFrom: string;
  /** The latest period the dialog was opened on: its id and version (a new period restarts at version 1). */
  expectedPeriodId: string;
  expectedVersion: number;
}

export async function changeTaxCodeAction(
  code: string,
  input: TaxCodeChangeInput,
): Promise<ActionState> {
  const session = await requireSection('tax');
  const parsedCode = TaxCodeCodeSchema.safeParse(code);
  const parsed = ChangeTaxCodeBodySchema.safeParse(input);
  if (!parsedCode.success) return fail('That tax code no longer exists. Reload the page.');
  if (!parsed.success) return fail(firstIssue(parsed.error.issues));
  try {
    await changeTaxCode(session, parsedCode.data, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok(`${parsedCode.data} changes on ${parsed.data.effectiveFrom}.`);
}

export async function retireTaxCodeAction(
  code: string,
  effectiveTo: string,
  expected: { expectedPeriodId: string; expectedVersion: number },
): Promise<ActionState> {
  const session = await requireSection('tax');
  const parsedCode = TaxCodeCodeSchema.safeParse(code);
  const parsed = RetireTaxCodeBodySchema.safeParse({
    effectiveTo,
    expectedPeriodId: expected.expectedPeriodId,
    expectedVersion: expected.expectedVersion,
  });
  if (!parsedCode.success) return fail('That tax code no longer exists. Reload the page.');
  if (!parsed.success) return fail(firstIssue(parsed.error.issues));
  try {
    await retireTaxCode(session, parsedCode.data, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok(`${parsedCode.data} is not offered from ${parsed.data.effectiveTo}.`);
}

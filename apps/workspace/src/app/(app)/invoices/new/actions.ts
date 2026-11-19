'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { hasPermission } from '@/components/p2/customers/permissions';
import { createManualInvoice } from '@/lib/api-billing';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

import { failureState, INCOMPLETE, keyOf, refusal, textOf } from './action-helpers';
import type { InvoiceFormState } from './form-state';
import { parseManualInvoice } from './forms';
import { parseLinesJson } from './lines';

/**
 * `POST /v1/invoices`: a tax invoice with no sales order. Serves the NFR "no double issue" and "amounts
 * are exact": the form carries an Idempotency-Key the page made once per render, the body carries
 * quantities, prices and tax codes only, and the person lands on the invoice the server answered
 * with, to read its totals. Nothing here computes an amount, a number or a date.
 *
 * Asks `requireStaffSession` first and checks `invoice.draft` (deny by default: the API still decides
 * every call). A form refused by validation is never posted, so the same key is still unused afterwards.
 * This file exports only async functions: a Server Actions file cannot export values.
 */
export async function createManualInvoiceAction(
  prev: InvoiceFormState,
  form: FormData,
): Promise<InvoiceFormState> {
  const session = await requireStaffSession('/invoices/new');
  const key = keyOf(form);
  if (!hasPermission(session.roles, 'invoice.draft')) {
    return refusal(
      key,
      'Your roles do not include drafting invoices. Ask an administrator if you need to.',
    );
  }

  const lines = parseLinesJson(textOf(form, 'lines'));
  if (lines === null) return { key, errors: { form: INCOMPLETE } };
  // The page's list again (D44): a currency switched off since the page loaded is refused here,
  // before the API. `loadEnabledCurrencies` never throws; a failed read gives the default list.
  const parsed = parseManualInvoice(
    {
      customerId: textOf(form, 'customerId'),
      currency: textOf(form, 'currency') as 'NPR',
      manualReason: textOf(form, 'manualReason'),
      dueDate: textOf(form, 'dueDate'),
      lines,
    },
    await loadEnabledCurrencies(session),
  );
  if (!parsed.ok) return { key, errors: parsed.errors };

  let id: string;
  try {
    id = (await createManualInvoice(session, parsed.data, key)).invoice.id;
  } catch (err) {
    return failureState(err, key);
  }

  revalidatePath('/invoices');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/invoices/${encodeURIComponent(id)}`);
}

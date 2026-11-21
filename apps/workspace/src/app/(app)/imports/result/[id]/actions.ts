'use server';

import { redirect } from 'next/navigation';

import { commitImport, importFailureMessage } from '@/lib/api-imports';
import { requireStaffSession } from '@/lib/bff';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates the valid rows of a previewed import. The API checks the grant of the batch's kind, looks for duplicates again
 * at the moment of the write and does it all in one transaction; committing twice answers the same result. Either way
 * the person lands back on the result page, which is read from the stored record.
 */
export async function commitImportAction(formData: FormData): Promise<void> {
  const raw = formData.get('id');
  const id = typeof raw === 'string' && GUID.test(raw) ? raw.toLowerCase() : null;
  if (id === null) redirect('/customers');
  const session = await requireStaffSession(`/imports/result/${id}`);
  let notice: string | undefined;
  try {
    await commitImport(session, id);
  } catch (err) {
    notice = importFailureMessage(err);
  }
  redirect(
    notice === undefined
      ? `/imports/result/${id}`
      : `/imports/result/${id}?${new URLSearchParams({ error: notice.slice(0, 300) })}`,
  );
}

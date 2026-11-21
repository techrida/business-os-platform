// Copy shared by the bank and expense account actions, forms and tests. A plain module because a
// 'use server' file may only export async functions.

/** Shown under Code when the API answers 409 to a new expense account. */
export const DUPLICATE_CODE_MESSAGE = 'That code is already used';

/** What retiring keeps working, said in the confirmation dialog. */
export const RETIRE_KEEPS_WORKING =
  'Documents already using it keep showing its name. A payment request still in draft must be created again from an active account before it can be submitted. You can reactivate the account later.';

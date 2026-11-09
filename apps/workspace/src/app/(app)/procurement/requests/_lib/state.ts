import type { FieldErrors } from './forms';

/** What the create and edit actions hand back to the purchase request form. */
export interface PrFormState {
  /** The idempotency key the next submit will use. Rotated after a definite refusal only. */
  key: string;
  errors: FieldErrors;
  /** A refusal that is not about one field: 403, 409, 422, 5xx or a lost connection. */
  error?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
}

/**
 * What the submit and cancel actions hand back. `count` rises on each success, so a form keyed
 * on it resets itself while a refusal keeps its key.
 */
export interface CommandState {
  key: string;
  error?: string;
  reload?: boolean;
  /** A short confirmation. */
  saved?: string;
  count: number;
}

export function commandStart(key: string): CommandState {
  return { key, count: 0 };
}

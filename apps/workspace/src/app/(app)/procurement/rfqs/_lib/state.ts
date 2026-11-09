export type { CommandState } from '../../requests/_lib/state';
export { commandStart } from '../../requests/_lib/state';

/** What the create and quotation actions hand back to their forms. */
export interface RfqFormState {
  /** The idempotency key the next submit will use. Rotated after a definite refusal only. */
  key: string;
  errors: Record<string, string>;
  /** A refusal that is not about one field: 403, 409, 422, 5xx or a lost connection. */
  error?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
}

/**
 * What the score action hands back. `count` rises on each success and the key is replaced, because
 * the same quotation is scored again with a different body: a reused key would replay the old one.
 */
export interface RfqEditState {
  key: string;
  errors: Record<string, string>;
  error?: string;
  reload?: boolean;
  /** A short confirmation. */
  saved?: string;
  count: number;
}

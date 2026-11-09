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

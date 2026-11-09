/** What every purchase order and receipt action hands back to its dialog or form. */
export interface ActionState {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  /** A refusal that is not about one field: 403, 409, 422, 5xx or a lost connection. */
  error?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
  /** One sentence per wrong field; the request never reached the API. Keyed by field or `<lineId>.<field>`. */
  errors?: Record<string, string>;
  /** The API accepted the request: what it did, in a sentence. */
  done?: string;
}

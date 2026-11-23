import type { CountryCode } from '@bos/contracts';

import type { ConversionCustomer } from './record-lookups';

/** What the step components share with the dialog: the typed values, how to change them, and the errors to show. */
export interface StepContext {
  values: Record<string, string>;
  patch: (p: Record<string, string>) => void;
  set: (name: string) => (e: { target: { value: string } }) => void;
  err: Partial<Record<string, string>>;
  /** Milliseconds typing must pause before a live search; tests pass 0. */
  searchDelayMs: number | undefined;
  /** One message for a failed lookup (a toast), so a failure is never silent. */
  onLookupError: (message: string) => void;
}

/** The customer the box shows as chosen (its label and muted PAN/number line come from here). */
export type ChosenCustomer = Pick<ConversionCustomer, 'id' | 'name'> &
  Partial<Pick<ConversionCustomer, 'number' | 'pan'>>;

export interface OrganisationState {
  chosen: ChosenCustomer | null;
  setChosen: (c: ChosenCustomer | null) => void;
  panEdited: boolean;
  setPanEdited: (edited: boolean) => void;
  customerCountry: CountryCode;
}

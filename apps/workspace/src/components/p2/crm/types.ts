import type { Move } from './stages';

/**
 * Plain shapes shared by server pages, server actions and Client Components. Types only, no
 * runtime import, so the browser bundle never pulls in the contracts or zod.
 */

export type { Move };

export interface MoveState {
  ok?: boolean;
  /** The stage label just moved to, for the confirmation line. */
  movedTo?: string;
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  /** True when the page is out of date (409): the form offers a reload. */
  reload?: boolean;
}

export type MoveAction = (prev: MoveState, form: FormData) => Promise<MoveState>;

/** One card on a board. Money and dates arrive already formatted, so the board does no maths. */
export interface BoardCard {
  id: string;
  href: string;
  title: string;
  number: string;
  /** A line under the title: company and contact, or the customer. */
  subtitle: string;
  /** Pre-formatted value, or null when none is set. */
  value: string | null;
  version: number;
  moves: Move[];
}

export interface BoardColumnData {
  stage: string;
  label: string;
  note?: string | undefined;
  cards: BoardCard[];
}

export interface FormState {
  /** What was typed, echoed back so a refusal never wipes the form. */
  values: Record<string, string>;
  fieldErrors: Partial<Record<string, string>>;
  error?: string;
  ok?: boolean;
}

export type FormAction = (prev: FormState, form: FormData) => Promise<FormState>;

export interface DuplicateInfo {
  kind: 'customer' | 'contact';
  id: string;
  label: string;
  matchedOn: string;
  customerId?: string | undefined;
}

export interface ConvertState extends FormState {
  /** Set when the server found a possible duplicate and wants a decision. */
  duplicates?: DuplicateInfo[];
  /** The API gave a definite answer, so the next try is a new decision and a new idempotency key. */
  definite?: boolean;
  reload?: boolean;
}

export type ConvertAction = (prev: ConvertState, form: FormData) => Promise<ConvertState>;

// What the memo form submits and how it is checked. Pure (no server-only imports) so it is unit-testable; the
// server actions in actions.ts call it. An internal memo carries no money: there is no amount or currency here.
import { MemoBodyFieldsSchema } from '@bos/contracts';

export interface MemoValues {
  title: string;
  body: string;
  template?: string | undefined;
}

export interface MemoFormState {
  values: MemoValues;
  fieldErrors: Partial<Record<keyof MemoValues, string>>;
  error?: string;
  savedTo?: string;
}

export const FIELD_MESSAGE: Record<keyof MemoValues, string> = {
  template: 'Check the department, date and staff selections.',
  title: 'Enter a title, up to 200 characters.',
  body: 'The body is too long. The limit is 10,000 characters.',
};

export function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export function readValues(form: FormData): MemoValues {
  return {
    title: text(form, 'title').trim(),
    body: text(form, 'body'),
    template: text(form, 'template') || undefined,
  };
}

/**
 * Checks the fields with the memo contract's unrefined field set: the form never sends money, and the API
 * (not this form) enforces that a memo without a template, which only a historical draft can be, keeps its
 * stored amount.
 */
export function validateMemo(values: MemoValues) {
  let template: unknown;
  try {
    template = values.template ? JSON.parse(values.template) : undefined;
  } catch {
    const fieldErrors: MemoFormState['fieldErrors'] = {};
    return { ok: false as const, fieldErrors, error: 'Invalid memo fields' };
  }
  const parsed = MemoBodyFieldsSchema.safeParse({
    title: values.title,
    body: values.body,
    template,
  });
  if (parsed.success) return { ok: true as const, data: parsed.data };
  const fieldErrors: MemoFormState['fieldErrors'] = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && key in FIELD_MESSAGE) {
      const k = key as keyof MemoValues;
      fieldErrors[k] ??= FIELD_MESSAGE[k];
    }
  }
  return { ok: false as const, fieldErrors };
}

import { describeError } from './admin-errors';

// A page reads several admin sections. Each section may fail on its own (the groups route needs a
// different permission than the workflows route), so one failure shows an inline notice for that
// section and the rest of the page still renders.
export type Section<T> = { ok: true; data: T } | { ok: false; message: string };

/** `action` completes "You don't have permission to ...", for example "view workflows". */
export async function section<T>(action: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, message: describeError(error, action) };
  }
}

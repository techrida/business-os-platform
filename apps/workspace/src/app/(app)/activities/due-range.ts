// Server-safe: the activities page reads the due-day range from the URL here.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day `YYYY-MM-DD`, or undefined (a malformed or impossible date is dropped, not sent). */
export function readDay(raw: string | undefined): string | undefined {
  if (raw === undefined || !DAY.test(raw)) return undefined;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : undefined;
}

/** The range the API is asked for. An inverted pair is read in order, since the API refuses it. */
export function dueRange(
  from: string | undefined,
  to: string | undefined,
): { dueFrom?: string; dueTo?: string } {
  const a = readDay(from);
  const b = readDay(to);
  const [start, end] = a !== undefined && b !== undefined && a > b ? [b, a] : [a, b];
  return {
    ...(start !== undefined ? { dueFrom: start } : {}),
    ...(end !== undefined ? { dueTo: end } : {}),
  };
}

// Evaluates a workflow rule's `when` condition against a request's facts. Pure, no I/O.
// Serves the NFR "money is exact": amounts arrive as decimal strings (amountNpr = "100000.01") and
// are compared with decimal.js, never as floats, so 1,00,000.01 is reliably more than 1,00,000.
import type { Condition } from '@bos/contracts';
import Decimal from 'decimal.js';

/**
 * A condition could not be evaluated: a fact is missing or has the wrong type. This is thrown, not
 * treated as "false", because a rule that silently fails to fire drops an approver from a money
 * decision. The caller (submit or preview) turns it into a 4xx so the subject's facts get fixed.
 */
export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionError';
  }
}

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** Reads `a.b.c` from the facts. Only own properties, so `__proto__` or `constructor` read nothing. */
function factAt(facts: Record<string, unknown>, field: string): unknown {
  let current: unknown = facts;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** A decimal from a finite number or a plain decimal string ("1e5" and "1,000" are refused). */
function toDecimal(value: unknown): Decimal | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? new Decimal(value) : undefined;
  if (typeof value === 'string' && DECIMAL_TEXT.test(value)) return new Decimal(value);
  return undefined;
}

export function evaluate(condition: Condition, facts: Record<string, unknown>): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluate(c, facts));
  if ('any' in condition) return condition.any.some((c) => evaluate(c, facts));

  const { field, op, value } = condition;
  const fact = factAt(facts, field);
  if (fact === undefined || fact === null) {
    throw new ConditionError(`fact "${field}" is missing`);
  }

  if (op === 'in') {
    if (typeof fact !== 'string' && typeof fact !== 'number' && typeof fact !== 'boolean') {
      throw new ConditionError(`fact "${field}" must be a string, number or boolean for "in"`);
    }
    return (value as string[]).includes(String(fact));
  }

  if (op === 'eq' || op === 'neq') {
    // Two numbers (or decimal strings) are equal by value, so "100000.00" eq 100000 is true.
    const a = toDecimal(fact);
    const b = toDecimal(value);
    const equal = a !== undefined && b !== undefined ? a.eq(b) : fact === value;
    return op === 'eq' ? equal : !equal;
  }

  const a = toDecimal(fact);
  const b = toDecimal(value);
  if (a === undefined) throw new ConditionError(`fact "${field}" is not a number`);
  if (b === undefined)
    throw new ConditionError(`the value compared with "${field}" is not a number`);
  switch (op) {
    case 'gt':
      return a.gt(b);
    case 'gte':
      return a.gte(b);
    case 'lt':
      return a.lt(b);
    case 'lte':
      return a.lte(b);
  }
}

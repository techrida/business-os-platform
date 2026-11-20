// Check a person (spec 6.2), the words around the API's report. Pure: no React, no server import.
// The report itself (reach, counts, who they can assign to, why) comes from the API; nothing here
// works out access.
import type { CheckPersonAreaRow, CheckPersonReport } from '@bos/contracts';
import { z } from 'zod';

import { LEVEL_LABEL, peopleText } from '../roles/_lib/reach';

export const CHECK_PATH = '/settings/access/check';
export const PICK_PROMPT = 'Pick a person to see what this person can open.';
export const PERSON_NOT_FOUND = 'This person could not be found. Pick someone else.';

type Person = CheckPersonReport['person'];

const STATUS_WORD: Readonly<Record<Person['status'], string>> = {
  active: 'Active',
  invited: 'Invited',
  inactive: 'Disabled',
};

/** The `person` query value when it is a well-formed id; anything else means nobody is chosen. */
export function personParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = z.guid().safeParse(first);
  return parsed.success ? parsed.data : null;
}

/** The address for one person, or the empty page when `id` is empty. */
export function checkHref(id: string): string {
  return id === '' ? CHECK_PATH : `${CHECK_PATH}?person=${encodeURIComponent(id)}`;
}

/** "Asha K. · Sales · Manager in Sales · Active". */
export function headerLine(person: Person): string {
  const roles = person.roles.map((r) => r.label).join(', ');
  const place = person.department
    ? `${LEVEL_LABEL[person.level]} in ${person.department.name}`
    : 'No department';
  return [person.name, roles, place, STATUS_WORD[person.status]].filter(Boolean).join(' · ');
}

/** The notice above the report, when the person's state needs one (spec 6.2 "States"). */
export function personNotice(person: Person): string | null {
  // Name the person, never "they": the notice reads as one person's state.
  const name = person.name.trim();
  if (person.roles.length === 0) {
    return name
      ? `${name} has no roles, so ${name} cannot open anything.`
      : 'This person has no roles, so this person cannot open anything.';
  }
  if (person.status === 'inactive') {
    return name
      ? `${name} is disabled and cannot sign in. This shows what ${name}'s roles would allow.`
      : "This person is disabled and cannot sign in. This shows what this person's roles would allow.";
  }
  return null;
}

const count = (n: number) => n.toLocaleString('en-US');

/** "48 of 120": how many records of the area the person can open, of all of them. */
export function visibleText(row: CheckPersonAreaRow): string {
  return `${count(row.visibleCount)} of ${count(row.totalCount)}`;
}

/** The actions the person may take in the area, or a plain "Nothing else". */
export function actionsText(row: CheckPersonAreaRow): string {
  return row.actions.length === 0 ? 'Nothing else' : row.actions.map((a) => a.label).join(', ');
}

/** "6 people", or null where nobody is assigned work in the area. */
export function assignText(row: CheckPersonAreaRow): string | null {
  return row.assignableCount === null ? null : peopleText(row.assignableCount);
}

/** Opens the By area card for this area. */
export function changeHref(row: CheckPersonAreaRow): string {
  return `/settings/access?area=${encodeURIComponent(row.area)}`;
}

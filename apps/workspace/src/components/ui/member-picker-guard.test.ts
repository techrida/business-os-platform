import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

// BOS-UI-001: a member of the organisation is chosen with MemberPicker (search in the input, name then muted role),
// never with the plain `Select` or a raw `Combobox` fed a list of people. This scans every workspace and portal
// component for a `<Select ...>` / `<Combobox ...>` whose own element text builds options from a list of people
// (owners, people, users, staff, members, assignees, approvers) and fails naming the component and file.

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const WORD = '(?:owners?|people|persons?|users?|staff|members?|assignees?|approvers?|candidates?|available)';
// A list of people turned into options (`owners.map(...)`, `options={people}`, `options={staffOptions(...)}`), not a
// control that merely mentions a person (a level, a sort order, "One person" as a kind of step).
const PERSON = new RegExp(
  `\\b${WORD}\\b(?:\\s*\\?\\?\\s*\\[\\]\\))?(?:\\([^)]*\\))?(?:\\.\\w+)*\\.map\\(|\\boptions=\\{[^}]*\\b${WORD}\\b`,
  'i',
);
// A raw Combobox is only for non-person lists (vendors, lost reasons); any person word in it is a person picker.
const PERSON_WORD = new RegExp(`\\b${WORD}\\b`, 'i');
// A control that posts a person's id (`name="ownerUserId"`, `assigneeUserId`, `v:crm.default_lead_owner`'s sibling) is a person picker whatever its options variable is called.
const POSTS_PERSON = /\bname=(?:"|'|\{[`'"])[^"'`}$]*(?:userid|owner|assignee|approver)/i;
const isPersonList = (el: { tag: string; text: string }) =>
  PERSON.test(el.text) ||
  POSTS_PERSON.test(el.text) ||
  (el.tag === 'Combobox' && PERSON_WORD.test(el.text));

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.next')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** The text of each `<Select` / `<Combobox` element: from its tag to its closing tag, or to `/>` when self-closing. */
export function selectElements(source: string): { tag: string; text: string; line: number }[] {
  const out: { tag: string; text: string; line: number }[] = [];
  const open = /<(Select|Combobox)\b/g;
  for (let m = open.exec(source); m; m = open.exec(source)) {
    const tag = m[1]!;
    const close = source.indexOf(`</${tag}>`, m.index);
    const next = source.indexOf(`<${tag}`, m.index + 1);
    // A self-closing element has no closing tag before the next one of its kind.
    const end =
      close !== -1 && (next === -1 || close < next)
        ? close
        : source.indexOf('/>', m.index) + 2 || source.length;
    out.push({
      tag,
      text: source.slice(m.index, end),
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/** Selects that mention a person word without choosing a person, each with the reason. */
const ALLOWED: Record<string, string> = {
  'apps/workspace/src/components/ui/member-picker.tsx': 'the picker itself wraps the Combobox',
};

const offenders = ['apps/workspace/src', 'apps/portal/src']
  .flatMap((dir) => sources(join(repo, dir)))
  .map((file) => relative(repo, file).split(sep).join('/'))
  .filter((file) => !(file in ALLOWED))
  .flatMap((file) =>
    selectElements(readFileSync(join(repo, file), 'utf8'))
      .filter(isPersonList)
      .map(
        (el) =>
          `${file}:${el.line} renders a person list through <${el.tag}>; use MemberPicker (BOS-UI-001)`,
      ),
  );

it('no person or user list is rendered through a plain Select or a raw Combobox', () => {
  expect(offenders).toEqual([]);
});

it('recognises the shapes the replaced person selects really had', () => {
  const shapes = [
    // owner-field.tsx and schedule-follow-up-dialog.tsx before BOS-UI-001: options built elsewhere.
    `<Select name="ownerUserId" value={chosen} onChange={(e) => setChosen(e.target.value)} options={options} disabled={pending} {...c} />`,
    `<Select name="assigneeUserId" defaultValue={defaultAssignee} options={options} {...c} />`,
    // user-field.tsx and the workflow editor's person step: `available.map` / `(users ?? []).map`.
    `<Select {...control} name={name} required>{available.map((u) => (<option key={u.id}>{u.label}</option>))}</Select>`,
    `<Select {...control} value={step.target}>{(users ?? []).map((u) => (<option key={u.id}>{u.label}</option>))}</Select>`,
  ];
  for (const shape of shapes) {
    expect(selectElements(shape).filter(isPersonList), shape).toHaveLength(1);
  }
});

it('recognises a person list in a plain Select (the guard fails on the old lead-form shape)', () => {
  const old = `<Select name="ownerUserId" value={v}>{owners.map((o) => <option key={o.value}>{o.label}</option>)}</Select>`;
  const found = selectElements(old).filter(isPersonList);
  expect(found).toHaveLength(1);
  const fine = `<Select name="stage">{stages.map((s) => <option key={s}>{s}</option>)}</Select>`;
  expect(selectElements(fine).filter(isPersonList)).toHaveLength(0);
  const raw = `<Combobox options={headOptions} placeholder="Search people" />`;
  expect(selectElements(raw).filter(isPersonList)).toHaveLength(1);
});

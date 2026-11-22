import {
  ACTIVITY_SUBJECT_KEYS,
  CancelActivityBodySchema,
  CompleteActivityBodySchema,
  ConvertLeadBodySchema,
  CreateActivityBodySchema,
  CreateLeadBodySchema,
  LeadStageChangeBodySchema,
  OpportunityStageChangeBodySchema,
  RescheduleActivityBodySchema,
  SCHEDULABLE_ACTIVITY_KINDS,
  USER_ACTIVITY_KINDS,
  UpdateLeadBodySchema,
  type ActivityDto,
  type CancelActivityBody,
  type CompleteActivityBody,
  type ConvertLeadBody,
  type CreateActivityBody,
  type CreateLeadBody,
  type LeadStageChangeBody,
  type OpportunityStageChangeBody,
  type PartyPhoneInput,
  type RecordKind,
  type RescheduleActivityBody,
  type SchedulableActivityKind,
  type UpdateLeadBody,
} from '@bos/contracts';
import { NO_SPACES, hasInnerSpace, plainAmount } from '@bos/locale';
import type { ZodType } from 'zod';

/**
 * Turns submitted forms into the contracts' request bodies, or into one plain sentence per field.
 * The browser's checks are a courtesy; these run on the server in every action. Pure functions on
 * `FormData`, so they are tested without a browser.
 */

export type FieldErrors = Partial<Record<string, string>>;
export type Parsed<T> = { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors };

const RELOAD = 'This page is out of date. Reload it and try again.';
const INCOMPLETE = 'This form is incomplete. Reload the page.';

/** A trimmed string field, or undefined when it is empty or missing. */
function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Keep only the keys that have a value, so empty inputs are left out of the body. */
function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function numberField(form: FormData, name: string): number | undefined {
  const v = field(form, name);
  return v === undefined ? undefined : Number(v);
}

/** People type 12,50,000.00 in Nepal; the contract wants plain digits. */
function moneyField(form: FormData, name: string): string | undefined {
  const v = field(form, name);
  return v === undefined ? undefined : plainAmount(v);
}

/** A `datetime-local` value is Kathmandu wall time. The contract wants an offset timestamp. */
export function kathmanduLocalToIso(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return `${v}:00+05:45`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return `${v}+05:45`;
  return v;
}

interface Issue {
  path: PropertyKey[];
  message: string;
}

/** First issue per field wins. `keyOf` maps an issue to the form field it belongs to. */
function collect(
  issues: readonly Issue[],
  keyOf: (path: PropertyKey[]) => string,
  messages: Record<string, string>,
  fallback: string,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = keyOf(issue.path);
    errors[key] ??= messages[key] ?? fallback;
  }
  return errors;
}

const lastKey = (path: PropertyKey[]): string => String(path[path.length - 1] ?? 'form');

// ---------------------------------------------------------------------------------------------
// Stage move
// ---------------------------------------------------------------------------------------------

const STAGE_MESSAGES: Record<string, string> = {
  stage: 'Choose a stage this record can move to.',
  reason: 'Give a reason, up to 200 characters.',
  lostReasonId: 'Choose a reason from the list, or add a new one.',
  newLostReason: 'Keep a new reason to 60 characters or fewer.',
  note: 'Add a note for the record, up to 2,000 characters.',
  contactKind: 'Choose call, email or meeting.',
  contactSubject: 'Say what the contact was about, up to 200 characters.',
  contactBody: 'Add a note about the call, email or meeting, up to 10,000 characters.',
  contactActivity: 'A contact note is only logged when moving to Contacted.',
  expectedVersion: RELOAD,
};

/** Maps `['contactActivity', 'kind' | 'subject' | 'body']` to the form's flat field names. */
function stageKey(path: PropertyKey[]): string {
  if (path[0] !== 'contactActivity') return lastKey(path);
  const key = String(path[1] ?? '');
  if (key === '') return 'contactActivity';
  return `contact${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function contactActivity(form: FormData): Record<string, unknown> | undefined {
  const kind = field(form, 'contactKind');
  const subject = field(form, 'contactSubject');
  const body = field(form, 'contactBody');
  if (kind === undefined && subject === undefined && body === undefined) return undefined;
  return defined({ kind, subject, body });
}

/** The stage field is checked against the user-reachable stages in the contract, so `won`, `quotation_sent` and `converted` are refused here too. */
export function parseStageMove(
  kind: RecordKind,
  form: FormData,
): Parsed<LeadStageChangeBody | OpportunityStageChangeBody> {
  const stage = field(form, 'stage');
  const input = defined({
    stage,
    reason: field(form, 'reason'),
    // A lead or opportunity moved to Lost carries an option of the tenant's list, or a new one to add (D49, D54-3).
    lostReasonId: field(form, 'lostReasonId'),
    newLostReason: field(form, 'newLostReason'),
    note: field(form, 'note'),
    ...(kind === 'lead' ? { contactActivity: contactActivity(form) } : {}),
    expectedVersion: numberField(form, 'expectedVersion') ?? Number.NaN,
  });
  const schema = kind === 'lead' ? LeadStageChangeBodySchema : OpportunityStageChangeBodySchema;
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, fieldErrors: collect(r.error.issues, stageKey, STAGE_MESSAGES, RELOAD) };
}

// ---------------------------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------------------------

const LEAD_MESSAGES: Record<string, string> = {
  title: 'Enter a title, up to 200 characters.',
  source: 'Choose where the lead came from.',
  companyName: 'Enter the company name, up to 200 characters.',
  contactName: 'Enter the contact person, up to 200 characters.',
  country: 'Choose a country from the list.',
  email: 'Enter an email address such as name@company.com.',
  phones: 'Check the phone numbers: mark one as primary and list each number once.',
  requirement: 'The requirement is too long. The limit is 5,000 characters.',
  expectedValue:
    'Enter an amount such as 1250000.50: digits with at most two decimals, not negative.',
  currency: 'Choose NPR, INR or USD.',
  probability: 'Enter a whole number from 0 to 100.',
  expectedClose: 'Enter a date.',
  nextFollowUpAt: 'Enter a date and time.',
  notes: 'The notes are too long. The limit is 5,000 characters.',
  campaign: 'The campaign is too long. The limit is 100 characters.',
  ownerUserId: 'Choose who owns this lead.',
  followUpKind: 'Choose call, meeting or email.',
  followUpAt: 'Choose when to follow up.',
  followUpAssigneeUserId: 'Choose who does the follow-up.',
  followUpSubject: 'Say what the follow-up is about, up to 200 characters.',
  followUpBody: 'The follow-up details are too long. The limit is 10,000 characters.',
};

/** `['followUp', 'dueAt']` belongs to the `followUpAt` input; the other follow-up keys add a prefix. */
function leadKey(path: PropertyKey[]): string {
  if (path[0] !== 'followUp') return lastKey(path);
  const key = String(path[1] ?? 'dueAt');
  if (key === 'dueAt') return 'followUpAt';
  return `followUp${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/**
 * The first follow-up is planned only when it has a time. The type buttons always post a kind, so
 * a kind, assignee or subject without a time is left out rather than refused.
 */
function leadFollowUp(form: FormData): Record<string, unknown> | undefined {
  const dueAt = kathmanduLocalToIso(field(form, 'followUpAt'));
  if (dueAt === undefined) return undefined;
  return defined({
    kind: field(form, 'followUpKind'),
    dueAt,
    assigneeUserId: field(form, 'followUpAssigneeUserId'),
    subject: field(form, 'followUpSubject'),
    body: field(form, 'followUpBody'),
  });
}

/** A lead needs a way to reach the person; the form shows this under the email before it submits. */
export const EMAIL_OR_PHONE = 'Enter an email or at least one phone number.';

/** More rows than a list can hold still reach the contract, which refuses them; this only bounds the loop. */
const PHONE_ROWS_READ = 20;

/** A contract phone problem ("not a valid United States number") as a sentence. */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/**
 * The numbers a `PhoneListInput` posted under `name` (`<name>.<i>.number`, `.country`, `.label`,
 * `.isPrimary`), blank rows left out. `rowOf[j]` is the list row of `phones[j]`, so an error on a
 * posted number lands under the row it came from. When the primary row was left blank, the first
 * number is primary, as the list itself reports it.
 */
export function formPhones(
  form: FormData,
  name: string,
): { phones: PartyPhoneInput[]; rowOf: number[] } {
  const phones: PartyPhoneInput[] = [];
  const rowOf: number[] = [];
  for (let row = 0; row < PHONE_ROWS_READ; row += 1) {
    const at = `${name}.${row}`;
    if (!form.has(`${at}.number`)) break;
    const e164 = field(form, `${at}.number`);
    if (e164 === undefined) continue;
    const label = field(form, `${at}.label`);
    phones.push({
      country: (field(form, `${at}.country`) ?? '') as PartyPhoneInput['country'],
      e164,
      ...(label === undefined ? {} : { label: label as NonNullable<PartyPhoneInput['label']> }),
      isPrimary: field(form, `${at}.isPrimary`) === 'true',
    });
    rowOf.push(row);
  }
  if (phones.length > 0 && !phones.some((phone) => phone.isPrimary)) phones[0]!.isPrimary = true;
  return { phones, rowOf };
}

/**
 * Lead create. `ownerUserId` comes from the "Lead owner" select (the API defaults to the caller
 * when it is absent). The first follow-up arrives as `followUpKind` + `followUpAt` (+ optional
 * assignee, subject, details); the older single `nextFollowUpAt` input is still read. The person's
 * numbers come from the `phones` list, each with its own country; an error on one is keyed
 * `phones.<row>`, one about the list `phones`.
 */
export function parseLead(form: FormData): Parsed<CreateLeadBody> {
  const { phones, rowOf } = formPhones(form, 'phones');
  const email = field(form, 'email');
  const input = defined({
    title: field(form, 'title'),
    source: field(form, 'source'),
    campaign: field(form, 'campaign'),
    ownerUserId: field(form, 'ownerUserId'),
    companyName: field(form, 'companyName'),
    contactName: field(form, 'contactName'),
    country: field(form, 'country'),
    email,
    phones,
    requirement: field(form, 'requirement'),
    expectedValue: moneyField(form, 'expectedValue'),
    currency: field(form, 'currency'),
    probability: numberField(form, 'probability'),
    expectedClose: field(form, 'expectedClose'),
    nextFollowUpAt: kathmanduLocalToIso(field(form, 'nextFollowUpAt')),
    followUp: leadFollowUp(form),
    notes: field(form, 'notes'),
  });
  const r = CreateLeadBodySchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const others = r.error.issues.filter((issue) => issue.path[0] !== 'phones');
  const fieldErrors = collect(others, leadKey, LEAD_MESSAGES, 'Check this field.');
  for (const issue of r.error.issues) {
    if (issue.path[0] !== 'phones') continue;
    const index = issue.path[1];
    const key =
      typeof index === 'number' && rowOf[index] !== undefined ? `phones.${rowOf[index]}` : 'phones';
    fieldErrors[key] ??= key === 'phones' ? LEAD_MESSAGES['phones'] : sentence(issue.message);
  }
  // Neither an email nor a number: the contract puts this on the email, in its own words.
  if (email === undefined && phones.length === 0) fieldErrors['email'] = EMAIL_OR_PHONE;
  // "10 50" is not 1050: say what to fix rather than the generic sentence.
  if (fieldErrors['expectedValue'] && hasInnerSpace(field(form, 'expectedValue') ?? '')) {
    fieldErrors['expectedValue'] = NO_SPACES;
  }
  return { ok: false, fieldErrors };
}

/**
 * Lead edit, from either of the detail page's editors: the owner, or the person's country and
 * numbers (D39: follow-ups are activities, not a lead field). The body is the contract's partial
 * update with only the keys the form posted. `phones` counts as posted when the list's first row
 * is on the form (a `PhoneListInput` clears its last row rather than removing it), and replaces
 * the whole list, so clearing every row sends `[]`; the server refuses that when the lead has no
 * email either. A form that posts none of the editable keys names the owner, as before.
 */
export function parseLeadUpdate(form: FormData): Parsed<UpdateLeadBody> {
  const ownerUserId = field(form, 'ownerUserId');
  const country = field(form, 'country');
  const listed = form.has('phones.0.number') ? formPhones(form, 'phones') : undefined;
  const expectedVersion = numberField(form, 'expectedVersion') ?? Number.NaN;
  const posted = defined({ ownerUserId, country, phones: listed?.phones });
  const r = UpdateLeadBodySchema.safeParse({ ...posted, expectedVersion });
  const changes = Object.keys(posted).length > 0;
  // Only the submitted keys: the contract's partial still applies the create-time currency
  // default, and sending it would reset a USD lead to NPR on an owner or phone change.
  if (r.success && changes) {
    const { ownerUserId: owner, country: code, phones } = r.data;
    return {
      ok: true,
      data: {
        ...(ownerUserId === undefined || owner === undefined ? {} : { ownerUserId: owner }),
        ...(country === undefined || code === undefined ? {} : { country: code }),
        ...(listed === undefined || phones === undefined ? {} : { phones }),
        expectedVersion: r.data.expectedVersion,
      },
    };
  }
  const issues = r.success ? [] : r.error.issues;
  const errors: FieldErrors = collect(
    issues.filter((issue) => issue.path[0] !== 'phones'),
    lastKey,
    { ...LEAD_MESSAGES, expectedVersion: RELOAD },
    RELOAD,
  );
  // As on create: a problem with one number goes under the row it came from.
  for (const issue of issues) {
    if (issue.path[0] !== 'phones') continue;
    const index = issue.path[1];
    const row = typeof index === 'number' ? listed?.rowOf[index] : undefined;
    const key = row === undefined ? 'phones' : `phones.${row}`;
    errors[key] ??= key === 'phones' ? LEAD_MESSAGES['phones'] : sentence(issue.message);
  }
  if (!changes) errors['ownerUserId'] = LEAD_MESSAGES['ownerUserId'];
  return { ok: false, fieldErrors: errors };
}

// ---------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------

/** Button labels for the activity kinds a person logs or plans (D40). */
export const ACTIVITY_KIND_LABELS: Record<(typeof USER_ACTIVITY_KINDS)[number], string> = {
  call: 'Call',
  meeting: 'Meeting',
  email: 'Email',
  note: 'Note',
};

/** Log activity offers every user kind; Schedule follow-up offers only the schedulable ones. */
export const LOG_ACTIVITY_KINDS = USER_ACTIVITY_KINDS;
export const SCHEDULE_ACTIVITY_KINDS = SCHEDULABLE_ACTIVITY_KINDS;

const NOTE_NOT_SCHEDULABLE =
  'A note records something that happened. Choose call, meeting or email to plan it.';

const ACTIVITY_MESSAGES: Record<string, string> = {
  kind: 'Choose call, meeting, email or note.',
  subject: 'Say what it was about, up to 200 characters.',
  body: 'The details are too long. The limit is 10,000 characters.',
  dueAt: 'Enter a date and time.',
  occurredAt: 'Enter a date and time.',
  assigneeUserId: 'Choose who does it.',
};

const activityKey = (path: PropertyKey[]): string =>
  String(path[0]) in ACTIVITY_MESSAGES ? String(path[0]) : 'form';

/** The two hidden inputs naming the record, or undefined when they are missing or unknown. */
function activitySubject(form: FormData): { key: string; id: string } | undefined {
  const key = field(form, 'subjectKind');
  const id = field(form, 'subjectId');
  const known = (ACTIVITY_SUBJECT_KEYS as readonly string[]).includes(key ?? '');
  return known && key !== undefined && id !== undefined ? { key, id } : undefined;
}

/**
 * Log an activity. The record it belongs to arrives as two hidden inputs, `subjectKind` (one of
 * the five id keys) and `subjectId`, so a body can never carry two subjects. The contract's own
 * refine (exactly one) runs on top. The activity's `subject` is its one-line topic, not the record.
 * `task` is not a user kind any more (D39), and a note with a due time is refused (a note is not
 * schedulable).
 */
export function parseActivity(form: FormData): Parsed<CreateActivityBody> {
  const subject = activitySubject(form);
  if (subject === undefined) return { ok: false, fieldErrors: { form: INCOMPLETE } };
  const input = defined({
    kind: field(form, 'kind'),
    subject: field(form, 'subject'),
    body: field(form, 'body'),
    dueAt: kathmanduLocalToIso(field(form, 'dueAt')),
    occurredAt: kathmanduLocalToIso(field(form, 'occurredAt')),
    assigneeUserId: field(form, 'assigneeUserId'),
    [subject.key]: subject.id,
  });
  const r = CreateActivityBodySchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors = collect(
    r.error.issues,
    activityKey,
    { ...ACTIVITY_MESSAGES, form: INCOMPLETE },
    INCOMPLETE,
  );
  if (input['kind'] === 'note' && input['dueAt'] !== undefined)
    errors['kind'] = NOTE_NOT_SCHEDULABLE;
  return { ok: false, fieldErrors: errors };
}

const SCHEDULE_MESSAGES: Record<string, string> = {
  ...ACTIVITY_MESSAGES,
  kind: 'Choose call, meeting or email.',
  dueAt: 'Choose when the follow-up is due.',
};

/**
 * Schedule a follow-up: a planned call, meeting or email (D39). The due time is required, a note
 * is refused, and an empty subject becomes the kind's label ("Call"), as the API does for the
 * follow-up planned with a new lead. No assignee means the API picks (the lead owner for a lead).
 */
export function parseScheduleFollowUp(form: FormData): Parsed<CreateActivityBody> {
  const subject = activitySubject(form);
  if (subject === undefined) return { ok: false, fieldErrors: { form: INCOMPLETE } };
  const kind = field(form, 'kind');
  const schedulable = (SCHEDULABLE_ACTIVITY_KINDS as readonly string[]).includes(kind ?? '');
  const dueAt = kathmanduLocalToIso(field(form, 'dueAt'));
  const errors: FieldErrors = {};
  if (!schedulable)
    errors['kind'] = kind === 'note' ? NOTE_NOT_SCHEDULABLE : SCHEDULE_MESSAGES['kind'];
  if (dueAt === undefined) errors['dueAt'] = SCHEDULE_MESSAGES['dueAt'];
  const input = defined({
    kind,
    subject:
      field(form, 'subject') ??
      (schedulable ? ACTIVITY_KIND_LABELS[kind as SchedulableActivityKind] : undefined),
    body: field(form, 'body'),
    dueAt,
    assigneeUserId: field(form, 'assigneeUserId'),
    [subject.key]: subject.id,
  });
  const r = CreateActivityBodySchema.safeParse(input);
  if (r.success && Object.keys(errors).length === 0) return { ok: true, data: r.data };
  const fromSchema = r.success
    ? {}
    : collect(r.error.issues, activityKey, { ...SCHEDULE_MESSAGES, form: INCOMPLETE }, INCOMPLETE);
  return { ok: false, fieldErrors: { ...fromSchema, ...errors } };
}

const FOLLOW_UP_MESSAGES: Record<string, string> = {
  expectedVersion: RELOAD,
  note: 'The note is too long. The limit is 10,000 characters.',
  occurredAt: 'Enter a date and time.',
  dueAt: 'Choose the new due time.',
  assigneeUserId: 'Choose who does the follow-up.',
};

function parseWith<T>(schema: ZodType<T>, input: Record<string, unknown>): Parsed<T> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, fieldErrors: collect(r.error.issues, lastKey, FOLLOW_UP_MESSAGES, RELOAD) };
}

/** Complete a planned follow-up: an optional note (appended to its details) and when it happened. */
export function parseCompleteActivity(form: FormData): Parsed<CompleteActivityBody> {
  return parseWith(
    CompleteActivityBodySchema,
    defined({
      expectedVersion: numberField(form, 'expectedVersion') ?? Number.NaN,
      note: field(form, 'note'),
      occurredAt: kathmanduLocalToIso(field(form, 'occurredAt')),
    }),
  );
}

/** Move a planned follow-up to a new time, optionally to another person. */
export function parseRescheduleActivity(form: FormData): Parsed<RescheduleActivityBody> {
  return parseWith(
    RescheduleActivityBodySchema,
    defined({
      expectedVersion: numberField(form, 'expectedVersion') ?? Number.NaN,
      dueAt: kathmanduLocalToIso(field(form, 'dueAt')),
      assigneeUserId: field(form, 'assigneeUserId'),
    }),
  );
}

export function parseCancelActivity(form: FormData): Parsed<CancelActivityBody> {
  return parseWith(
    CancelActivityBodySchema,
    defined({ expectedVersion: numberField(form, 'expectedVersion') ?? Number.NaN }),
  );
}

/** A due time strictly before `now`. Null or unreadable times are never overdue. */
export function isPastDue(dueAt: string | null | undefined, now: Date = new Date()): boolean {
  if (dueAt === null || dueAt === undefined) return false;
  const at = Date.parse(dueAt);
  return Number.isFinite(at) && at < now.getTime();
}

/**
 * Overdue = planned and its due time has passed (D39; clients compute it, nothing is stored).
 * Completed, cancelled and logged activities are never overdue. For a lead's next follow-up
 * (`LeadDto.nextFollowUpAt`, already the earliest planned due time) use `isPastDue`.
 */
export function isOverdue(
  activity: Pick<ActivityDto, 'planned' | 'dueAt'>,
  now: Date = new Date(),
): boolean {
  return activity.planned && isPastDue(activity.dueAt, now);
}

// ---------------------------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------------------------

const CONVERT_MESSAGES: Record<string, string> = {
  customerId: 'Enter the id of the existing customer.',
  legalName: 'Enter the customer legal name, up to 200 characters.',
  panVatNo: 'Enter 5 to 20 letters, digits or hyphens.',
  industry: 'The industry is too long. The limit is 100 characters.',
  'address.line': 'Enter the street address, up to 300 characters.',
  'address.city': 'Enter the city, up to 100 characters.',
  'address.country': 'Choose the country from the list.',
  contactId: 'Enter the id of the existing contact.',
  contactName: 'Enter the contact name.',
  contactEmail: 'Enter the contact email, such as name@company.com. Quotations are sent to it.',
  contactCountry: "Choose the contact's country from the list.",
  contactPhones: 'Check the phone numbers: mark one as primary and list each number once.',
  opportunityName: 'Name the opportunity, up to 200 characters.',
  overrideReason: 'Give the reason for creating a duplicate, up to 500 characters.',
  expectedVersion: RELOAD,
  customerMode: INCOMPLETE,
  contactMode: 'Choose a contact: create one from the lead, or link an existing one with an email.',
};

const CONVERT_KEY: Record<string, string> = {
  contact: 'contactMode',
  fullName: 'contactName',
  email: 'contactEmail',
  reason: 'overrideReason',
};

/**
 * The form field a convert issue belongs to. The customer's country sits in its address block, so
 * it is `address.country`; the contact's is `contactCountry`; a phone row is `contactPhones.<row>`
 * by its list position (`rowOf`), the list as a whole `contactPhones`.
 */
function convertKey(path: readonly PropertyKey[], rowOf: readonly number[]): string {
  const [top, , leaf, sub] = path;
  if (top === 'customer' && leaf === 'address') return `address.${String(sub ?? 'line')}`;
  if (top === 'customer' && leaf === 'country') return 'address.country';
  if (top === 'contact' && leaf === 'country') return 'contactCountry';
  if (top === 'contact' && leaf === 'phones') {
    const row = typeof sub === 'number' ? rowOf[sub] : undefined;
    return row === undefined ? 'contactPhones' : `contactPhones.${row}`;
  }
  const key = lastKey([...path]);
  return CONVERT_KEY[key] ?? key;
}

/**
 * Lead conversion. A new customer posts its country from the address block (`address.country`,
 * no default) with `address.line` and `address.city`; a Nepal customer's PAN is nine digits, a
 * foreign one's is loose and optional. A new contact posts `contactCountry` and the
 * `contactPhones` list, each number with its own country.
 */
export function parseConvert(form: FormData): Parsed<ConvertLeadBody> {
  const customerMode = field(form, 'customerMode');
  // A contact is required (its email receives the quotations); there is no "none" any more.
  const contactMode = field(form, 'contactMode');
  const createAnyway = field(form, 'createAnyway') !== undefined;
  const overrideReason = field(form, 'overrideReason');

  const customer =
    customerMode === 'existing'
      ? { mode: 'existing', customerId: field(form, 'customerId') }
      : {
          mode: 'create',
          customer: defined({
            legalName: field(form, 'legalName'),
            panVatNo: field(form, 'panVatNo'),
            industry: field(form, 'industry'),
            relationship: 'prospect',
            country: field(form, 'address.country'),
            address: defined({
              line: field(form, 'address.line'),
              city: field(form, 'address.city'),
            }),
          }),
        };

  let contact: Record<string, unknown> | undefined;
  let rowOf: number[] = [];
  if (contactMode === 'existing') {
    contact = { mode: 'existing', contactId: field(form, 'contactId') };
  } else if (contactMode === 'create') {
    const posted = formPhones(form, 'contactPhones');
    rowOf = posted.rowOf;
    contact = {
      mode: 'create',
      contact: defined({
        fullName: field(form, 'contactName'),
        email: field(form, 'contactEmail'),
        country: field(form, 'contactCountry'),
        phones: posted.phones,
        // The main contact of a new customer. An existing customer may already have one (a second
        // would be a 409), so a contact added to it is an ordinary one.
        isPrimary: customerMode !== 'existing',
      }),
    };
  }

  const input = defined({
    customer,
    contact,
    opportunityName: field(form, 'opportunityName'),
    duplicateOverride:
      createAnyway && overrideReason !== undefined ? { reason: overrideReason } : undefined,
    expectedVersion: numberField(form, 'expectedVersion') ?? Number.NaN,
  });

  const earlyErrors: FieldErrors = {};
  if (createAnyway && overrideReason === undefined) {
    earlyErrors['overrideReason'] = CONVERT_MESSAGES['overrideReason'];
  }
  const r = ConvertLeadBodySchema.safeParse(input);
  if (r.success && Object.keys(earlyErrors).length === 0) return { ok: true, data: r.data };
  const fromSchema: FieldErrors = {};
  for (const issue of r.success ? [] : r.error.issues) {
    const key = convertKey(issue.path, rowOf);
    // A phone row, and a Nepal PAN that is not nine digits, keep the contract's own reason.
    const own = key.startsWith('contactPhones.') || (key === 'panVatNo' && issue.code === 'custom');
    fromSchema[key] ??= own
      ? sentence(issue.message)
      : (CONVERT_MESSAGES[key] ?? 'Check this field.');
  }
  return { ok: false, fieldErrors: { ...fromSchema, ...earlyErrors } };
}

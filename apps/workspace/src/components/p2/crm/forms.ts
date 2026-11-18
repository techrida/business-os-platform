import {
  ACTIVITY_SUBJECT_KEYS,
  ConvertLeadBodySchema,
  CreateActivityBodySchema,
  CreateLeadBodySchema,
  LeadStageChangeBodySchema,
  OpportunityStageChangeBodySchema,
  type ConvertLeadBody,
  type CreateActivityBody,
  type CreateLeadBody,
  type LeadStageChangeBody,
  type OpportunityStageChangeBody,
  type RecordKind,
} from '@bos/contracts';

/**
 * Turns submitted forms into the contracts' request bodies, or into one plain sentence per field.
 * The browser's checks are a courtesy; these run on the server in every action. Pure functions on
 * `FormData`, so they are tested without a browser.
 */

export type FieldErrors = Partial<Record<string, string>>;
export type Parsed<T> = { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors };

const RELOAD = 'This page is out of date. Reload it and try again.';
const INCOMPLETE = 'This form is incomplete. Reload the page.';
const PHONE = 'Enter the number with its country code, for example +9779812345678.';

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
  return v === undefined ? undefined : v.replace(/[\s,]/g, '');
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
  note: 'Add a note for the record, up to 2,000 characters.',
  expectedVersion: RELOAD,
};

/** The stage field is checked against the user-reachable stages in the contract, so `won`, `quotation_sent` and `converted` are refused here too. */
export function parseStageMove(
  kind: RecordKind,
  form: FormData,
): Parsed<LeadStageChangeBody | OpportunityStageChangeBody> {
  const input = defined({
    stage: field(form, 'stage'),
    reason: field(form, 'reason'),
    note: field(form, 'note'),
    expectedVersion: numberField(form, 'expectedVersion') ?? Number.NaN,
  });
  const schema = kind === 'lead' ? LeadStageChangeBodySchema : OpportunityStageChangeBodySchema;
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, fieldErrors: collect(r.error.issues, lastKey, STAGE_MESSAGES, RELOAD) };
}

// ---------------------------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------------------------

const LEAD_MESSAGES: Record<string, string> = {
  title: 'Enter a title, up to 200 characters.',
  source: 'Choose where the lead came from.',
  companyName: 'Enter the company name, up to 200 characters.',
  contactName: 'Enter the contact person, up to 200 characters.',
  email: 'Enter an email address such as name@company.com.',
  phone: PHONE,
  requirement: 'The requirement is too long. The limit is 5,000 characters.',
  expectedValue:
    'Enter an amount such as 1250000.50: digits with at most two decimals, not negative.',
  currency: 'Choose NPR, INR or USD.',
  probability: 'Enter a whole number from 0 to 100.',
  expectedClose: 'Enter a date.',
  nextFollowUpAt: 'Enter a date and time.',
  notes: 'The notes are too long. The limit is 5,000 characters.',
  campaign: 'The campaign is too long. The limit is 100 characters.',
};

export function parseLead(form: FormData): Parsed<CreateLeadBody> {
  const input = defined({
    title: field(form, 'title'),
    source: field(form, 'source'),
    campaign: field(form, 'campaign'),
    companyName: field(form, 'companyName'),
    contactName: field(form, 'contactName'),
    email: field(form, 'email'),
    phone: field(form, 'phone'),
    requirement: field(form, 'requirement'),
    expectedValue: moneyField(form, 'expectedValue'),
    currency: field(form, 'currency'),
    probability: numberField(form, 'probability'),
    expectedClose: field(form, 'expectedClose'),
    nextFollowUpAt: kathmanduLocalToIso(field(form, 'nextFollowUpAt')),
    notes: field(form, 'notes'),
  });
  const r = CreateLeadBodySchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    fieldErrors: collect(r.error.issues, lastKey, LEAD_MESSAGES, 'Check this field.'),
  };
}

// ---------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------

const ACTIVITY_MESSAGES: Record<string, string> = {
  kind: 'Choose call, meeting, email, note or task.',
  subject: 'Say what it was about, up to 200 characters.',
  body: 'The details are too long. The limit is 10,000 characters.',
  dueAt: 'Enter a date and time.',
};

/**
 * The record an activity belongs to arrives as two hidden inputs, `subjectKind` (one of the five
 * id keys) and `subjectId`, so a body can never carry two subjects. The contract's own refine
 * (exactly one) runs on top. The activity's `subject` is its one-line topic, not the record.
 */
export function parseActivity(form: FormData): Parsed<CreateActivityBody> {
  const subjectKind = field(form, 'subjectKind');
  const subjectId = field(form, 'subjectId');
  const known = (ACTIVITY_SUBJECT_KEYS as readonly string[]).includes(subjectKind ?? '');
  if (!known || subjectKind === undefined || subjectId === undefined) {
    return { ok: false, fieldErrors: { form: INCOMPLETE } };
  }
  const input = defined({
    kind: field(form, 'kind'),
    subject: field(form, 'subject'),
    body: field(form, 'body'),
    dueAt: kathmanduLocalToIso(field(form, 'dueAt')),
    [subjectKind]: subjectId,
  });
  const r = CreateActivityBodySchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors = collect(
    r.error.issues,
    (path) => (String(path[0]) in ACTIVITY_MESSAGES ? String(path[0]) : 'form'),
    { ...ACTIVITY_MESSAGES, form: INCOMPLETE },
    INCOMPLETE,
  );
  return { ok: false, fieldErrors: errors };
}

// ---------------------------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------------------------

const CONVERT_MESSAGES: Record<string, string> = {
  customerId: 'Enter the id of the existing customer.',
  legalName: 'Enter the customer legal name, up to 200 characters.',
  panVatNo: 'Enter 5 to 20 letters, digits or hyphens.',
  industry: 'The industry is too long. The limit is 100 characters.',
  line1: 'Enter the first line of the address.',
  city: 'Enter the city.',
  country: 'Enter a two-letter country code such as NP.',
  contactId: 'Enter the id of the existing contact.',
  contactName: 'Enter the contact name.',
  contactEmail: 'Enter the contact email, such as name@company.com. Quotations are sent to it.',
  contactPhone: PHONE,
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
  phone: 'contactPhone',
  reason: 'overrideReason',
};

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
            address: defined({
              line1: field(form, 'line1'),
              city: field(form, 'city'),
              country: field(form, 'country') ?? 'NP',
            }),
          }),
        };

  let contact: Record<string, unknown> | undefined;
  if (contactMode === 'existing') {
    contact = { mode: 'existing', contactId: field(form, 'contactId') };
  } else if (contactMode === 'create') {
    contact = {
      mode: 'create',
      contact: defined({
        fullName: field(form, 'contactName'),
        email: field(form, 'contactEmail'),
        phone: field(form, 'contactPhone'),
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
  const fromSchema = r.success
    ? {}
    : collect(
        r.error.issues,
        (path) => {
          const key = lastKey(path);
          return CONVERT_KEY[key] ?? key;
        },
        CONVERT_MESSAGES,
        'Check this field.',
      );
  return { ok: false, fieldErrors: { ...fromSchema, ...earlyErrors } };
}

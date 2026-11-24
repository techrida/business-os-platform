// The dev personas and the password and TOTP-secret handling for `.dev/personas.json`.
//
// P1 adds the Accountant persona (approval step 1, NFR separation of duties) and a per-persona
// `totpSecret`, because the login policy forces MFA and Playwright must be able to type codes.
import { randomInt } from 'node:crypto';

import type { OrgKind } from '@bos/contracts';
import { z } from 'zod';

export const PROJECT_NAME = 'business-os';
export const APP_NAME = 'workspace';
export const PROJECT_ROLES = [
  'founder',
  'management',
  'finance',
  'sales',
  'accountant',
  'customer_user',
  'vendor_user',
  // P2 (ADR 0027 section 3). A test keeps this list equal to ROLE_KEYS in contracts.
  'pmo',
  'operations_head',
  'procurement',
  // P4 (Kuu D03): receipts go to warehouse, and receiver is gone.
  'warehouse',
  'operations_officer',
  // D50: Marketing creates and hands off leads. Its dev users are the Marketing department personas below.
  'marketing',
] as const;
export type RoleKey = (typeof PROJECT_ROLES)[number];

export const ORG_NAMES = { customer: 'Dev Customer Co', vendor: 'Dev Vendor Co' } as const;

/**
 * Two more vendors for dev and QA (R6Q15): each has its own ZITADEL org, party and login, so the portal specs that
 * need "another approved vendor" or "a vendor awaiting KYC" (Know Your Business: the identity check) have a real user.
 * They exist only through this dev seed (assertDevTarget refuses a non-local issuer; seedKernelRows writes their
 * vendor rows only when it is handed the dev personas), never through a production path.
 */
export const EXTRA_VENDORS = [
  {
    key: 'vendor2',
    orgName: 'Dev Vendor Two Co',
    partyCode: 'VEND-DEV2',
    status: 'approved',
    /** A nine-digit Nepal PAN (vendors_pan_check), distinct from VEND-DEV's. Fictional. */
    pan: '234567891',
  },
  {
    key: 'vendorpending',
    orgName: 'Dev Vendor Pending Co',
    partyCode: 'VEND-DEVKYC',
    status: 'pending_kyc',
    pan: '345678912',
  },
] as const;
export type ExtraVendorKey = (typeof EXTRA_VENDORS)[number]['key'];
export type ExtraVendorSpec = (typeof EXTRA_VENDORS)[number];

export interface PersonaSpec {
  /** Stable key, also the local part of the username. */
  key: string;
  givenName: string;
  familyName: string;
  orgKind: OrgKind;
  role: RoleKey;
  /** A vendor of its own (EXTRA_VENDORS) instead of the shared Dev Vendor Co org. */
  vendorOrg?: ExtraVendorKey;
}

export const PERSONAS: readonly PersonaSpec[] = [
  { key: 'founder', givenName: 'Dev', familyName: 'Founder', orgKind: 'staff', role: 'founder' },
  {
    key: 'management',
    givenName: 'Dev',
    familyName: 'Management',
    orgKind: 'staff',
    role: 'management',
  },
  { key: 'finance', givenName: 'Dev', familyName: 'Finance', orgKind: 'staff', role: 'finance' },
  { key: 'sales', givenName: 'Dev', familyName: 'Sales', orgKind: 'staff', role: 'sales' },
  {
    key: 'customer',
    givenName: 'Dev',
    familyName: 'Customer',
    orgKind: 'customer',
    role: 'customer_user',
  },
  { key: 'vendor', givenName: 'Dev', familyName: 'Vendor', orgKind: 'vendor', role: 'vendor_user' },
  // Frozen contract (P1): Playwright logs in as accountant@dev.bos.test.
  {
    key: 'accountant',
    givenName: 'Dev',
    familyName: 'Accountant',
    orgKind: 'staff',
    role: 'accountant',
  },
  // P4 (Kuu D03, AD8). Appended after the frozen P1 personas, so earlier orders and logins do not change.
  {
    key: 'procurement',
    givenName: 'Dev',
    familyName: 'Procurement',
    orgKind: 'staff',
    role: 'procurement',
  },
  // Confirms goods receipts (`procurement.receipt.confirm`).
  {
    key: 'warehouse',
    givenName: 'Dev',
    familyName: 'Warehouse',
    orgKind: 'staff',
    role: 'warehouse',
  },
  // The head of a department: they are named in departments.head_user_id, which is not a role.
  {
    key: 'depthead',
    givenName: 'Dev',
    familyName: 'Department Head',
    orgKind: 'staff',
    role: 'operations_officer',
  },
  // The second Management user: AD8 needs two distinct Management approvers on a Founder's own purchase.
  {
    key: 'management2',
    givenName: 'Dev',
    familyName: 'Management Two',
    orgKind: 'staff',
    role: 'management',
  },
  // The second Finance user: a credit or debit note a Finance user raised needs an independent Finance
  // approver (separation of duties). Appended last, so earlier orders and logins do not change.
  {
    key: 'finance2',
    givenName: 'Dev',
    familyName: 'Finance Two',
    orgKind: 'staff',
    role: 'finance',
  },
  // U20a phase 2 (D50, D51): one Sales and one Marketing department with a person at every level, so the access
  // model (own at staff, department at manager and head, who may assign to whom) can be tried by switching user.
  // Appended last, so earlier orders and logins do not change. The `sales` persona above is the Sales staff member;
  // `sales2` is a second staff member, so staff-to-peer rules have someone to act on.
  { key: 'sales2', givenName: 'Dev', familyName: 'Sales Two', orgKind: 'staff', role: 'sales' },
  {
    key: 'salesmgr',
    givenName: 'Dev',
    familyName: 'Sales Manager',
    orgKind: 'staff',
    role: 'sales',
  },
  { key: 'saleshead', givenName: 'Dev', familyName: 'Sales Head', orgKind: 'staff', role: 'sales' },
  {
    key: 'marketing',
    givenName: 'Dev',
    familyName: 'Marketing',
    orgKind: 'staff',
    role: 'marketing',
  },
  {
    key: 'marketingmgr',
    givenName: 'Dev',
    familyName: 'Marketing Manager',
    orgKind: 'staff',
    role: 'marketing',
  },
  {
    key: 'marketinghead',
    givenName: 'Dev',
    familyName: 'Marketing Head',
    orgKind: 'staff',
    role: 'marketing',
  },
  // R6Q15: a second approved vendor and a vendor still in KYC, each in an org of its own. Appended last, so earlier
  // orders and logins do not change.
  {
    key: 'vendor2',
    // The switcher shows the name ZITADEL holds (given and family name), and `logins` the persona label, so the two
    // names are written to read as plain role labels.
    givenName: 'Vendor 2',
    familyName: '(approved)',
    orgKind: 'vendor',
    role: 'vendor_user',
    vendorOrg: 'vendor2',
  },
  {
    key: 'vendorpending',
    givenName: 'Vendor awaiting',
    familyName: 'KYC',
    orgKind: 'vendor',
    role: 'vendor_user',
    vendorOrg: 'vendorpending',
  },
];

/** The key of the ZITADEL org a persona signs in under: its own vendor org, else the org of its kind. */
export const personaOrgKey = (persona: PersonaSpec): string => persona.vendorOrg ?? persona.orgKind;

/** `.test` is reserved (RFC 2606), so these addresses can never reach a real mailbox. */
export const personaUsername = (key: string): string => `${key}@dev.bos.test`;

/** One entry of `.dev/personas.json` (a JSON array). The persona switcher and Playwright read it. */
export const PersonaEntrySchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  orgKind: z.enum(['staff', 'customer', 'vendor']),
  role: z.string(),
  /** What the user types, and what the switcher passes as `login_hint`. */
  username: z.string().min(1),
  /** The name ZITADEL itself reports (may carry an org domain suffix). */
  preferredLoginName: z.string(),
  password: z.string().min(8),
  /**
   * Base32 TOTP secret registered in ZITADEL (P1, frozen contract: the Playwright helper reads it).
   * Optional: absent until the seed has registered TOTP for this persona. Secret: never log it.
   */
  totpSecret: z.string().min(1).optional(),
});
export type PersonaEntry = z.infer<typeof PersonaEntrySchema>;
export const PersonasFileSchema = z.array(PersonaEntrySchema);

const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no l: easy to misread when a human types it
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const DIGIT = '23456789';
const SYMBOL = '-_.!#%*+=?';
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

const pick = (alphabet: string): string => alphabet.charAt(randomInt(alphabet.length));

/**
 * 24 random characters with at least one lower, upper, digit and symbol, because ZITADEL's default
 * password policy demands all four classes. Positions are shuffled with `crypto.randomInt`
 * (Fisher-Yates), so the guaranteed characters are not always at the front.
 */
export function generatePassword(length = 24): string {
  if (length < 8) throw new Error('password length must be at least 8');
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = a;
  }
  return chars.join('');
}

/** Existing passwords by persona key; unreadable or invalid files count as "no passwords yet". */
export function passwordsFromFile(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (text === undefined) return out;
  try {
    const parsed = PersonasFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) for (const p of parsed.data) out.set(p.key, p.password);
  } catch {
    // Corrupt JSON: regenerate. Existing ZITADEL users get a new password through SetPassword.
  }
  return out;
}

/** Stored TOTP secrets by persona key; same tolerance for bad files as `passwordsFromFile`. */
export function totpSecretsFromFile(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (text === undefined) return out;
  try {
    const parsed = PersonasFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      for (const p of parsed.data) if (p.totpSecret !== undefined) out.set(p.key, p.totpSecret);
    }
  } catch {
    // Corrupt JSON: no secrets known. The seed then reports registered-but-lost TOTPs loudly.
  }
  return out;
}

export const renderPersonasFile = (entries: PersonaEntry[]): string =>
  `${JSON.stringify(entries, null, 2)}\n`;

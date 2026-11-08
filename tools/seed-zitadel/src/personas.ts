// The dev personas and the password handling for `.dev/personas.json`.
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
  'customer_user',
  'vendor_user',
] as const;
export type RoleKey = (typeof PROJECT_ROLES)[number];

export const ORG_NAMES = { customer: 'Dev Customer Co', vendor: 'Dev Vendor Co' } as const;

export interface PersonaSpec {
  /** Stable key, also the local part of the username. */
  key: string;
  givenName: string;
  familyName: string;
  orgKind: OrgKind;
  role: RoleKey;
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
];

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

export const renderPersonasFile = (entries: PersonaEntry[]): string =>
  `${JSON.stringify(entries, null, 2)}\n`;

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * The personas the seed wrote (`.dev/personas.json`, a JSON array). This is the only place the
 * e2e tests read passwords, and they are only ever typed into ZITADEL's own form.
 * The schema mirrors tools/seed-zitadel/src/personas.ts (PersonaEntrySchema).
 */
const PersonaSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  orgKind: z.enum(['staff', 'customer', 'vendor']),
  role: z.string(),
  username: z.string().min(1),
  preferredLoginName: z.string(),
  password: z.string().min(8),
  /**
   * Base32 TOTP seed the seed script registered with ZITADEL (SHA-1, 6 digits, 30 s). Optional so
   * a `.dev/personas.json` written before MFA was turned on still parses; the login helper then
   * fails with a clear message instead of this file rejecting the whole list.
   */
  totpSecret: z
    .string()
    .regex(/^[A-Za-z2-7]+=*$/, 'totpSecret must be a base32 string')
    .optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** The twenty personas `pnpm seed` creates (PERSONAS in tools/seed-zitadel/src/personas.ts). */
export const PERSONA_KEYS = [
  'founder',
  'management',
  'finance',
  'sales',
  'customer',
  'vendor',
  'accountant',
  'procurement',
  'warehouse',
  'depthead',
  'management2',
  'finance2',
  'sales2',
  'salesmgr',
  'saleshead',
  'marketing',
  'marketingmgr',
  'marketinghead',
  'vendor2',
  'vendorpending',
] as const;

/** Playwright runs with `apps/workspace` as the working directory. */
export function personasFile(): string {
  return path.resolve(
    process.cwd(),
    process.env.BOS_DEV_PERSONAS_FILE ?? '../../.dev/personas.json',
  );
}

export function loadPersonas(): Persona[] {
  const file = personasFile();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Cannot read ${file}. Run \`pnpm seed\` against the running stack first.`);
  }
  const parsed = z.array(PersonaSchema).safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(`${file} is not a valid personas file: ${parsed.error.message}`);
  return parsed.data;
}

export function persona(key: string): Persona {
  const found = loadPersonas().find((p) => p.key === key);
  if (!found) throw new Error(`No persona "${key}" in ${personasFile()}`);
  return found;
}

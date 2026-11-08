import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { notFound } from 'next/navigation';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CenteredPage } from '@/components/ui/centered-page';
import { LinkCard, LinkCardList } from '@/components/ui/link-card';
import { Stack } from '@/components/ui/stack';

/**
 * Dev-only persona switcher: one link per seeded ZITADEL user, each starting a real OIDC login
 * with that user's login name pre-filled. It signs nobody in by itself and has no bypass: the
 * person (or Playwright) still types the password into ZITADEL.
 *
 * Three walls keep it out of production (risk R12):
 *  1. `pageExtensions` in next.config.ts only lists `dev.tsx` in development, so Next's route
 *     discovery (`page.(tsx|ts)`) does not see `page.dev.tsx` in a production build.
 *  2. `notFound()` below, for the day wall 1 is misconfigured or `NODE_ENV` is wrong.
 *  3. scripts/check-no-dev-routes.mjs fails CI if the route or the marker is in `.next/`.
 */

export const dynamic = 'force-dynamic';

// Reads the file the seed writes. The schema names only the fields this page may show, and zod
// drops every other key while parsing, so the `password` field never enters this component.
const PersonaSchema = z.object({
  key: z.string(),
  label: z.string(),
  orgKind: z.string(),
  role: z.string(),
  username: z.string(),
  preferredLoginName: z.string(),
});
type Persona = z.infer<typeof PersonaSchema>;

type Loaded = { ok: true; personas: Persona[] } | { ok: false; reason: string };

async function loadPersonas(): Promise<Loaded> {
  // Relative paths resolve from the app's working directory (apps/workspace) when `next dev` runs.
  const file = path.resolve(
    process.cwd(),
    process.env.BOS_DEV_PERSONAS_FILE ?? '../../.dev/personas.json',
  );
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { ok: false, reason: `Could not read ${file}. Run \`pnpm seed\` first.` };
  }
  try {
    const parsed = z.array(PersonaSchema).safeParse(JSON.parse(text));
    if (!parsed.success)
      return { ok: false, reason: `${file} does not look like a personas file.` };
    return { ok: true, personas: parsed.data };
  } catch {
    return { ok: false, reason: `${file} is not valid JSON.` };
  }
}

/** The same URL Playwright's login helper opens: `prompt=login` ignores any existing ZITADEL session. */
function loginHref(persona: Persona): string {
  const query = new URLSearchParams({ login_hint: persona.preferredLoginName, prompt: 'login' });
  return `/auth/login?${query.toString()}`;
}

export default async function DevPersonasPage() {
  if (process.env.NODE_ENV !== 'development') notFound();

  const loaded = await loadPersonas();

  return (
    <CenteredPage width="wide">
      <Stack as="main" gap="large" data-marker="BOS_DEV_PERSONA_SWITCHER">
        <Stack gap="small">
          <h1>Dev personas</h1>
          <p>
            Development only. Each link starts a real ZITADEL login for that user. The passwords are
            in <code>.dev/personas.json</code>, which this page never reads out.
          </p>
        </Stack>
        {loaded.ok ? (
          <LinkCardList>
            {loaded.personas.map((persona) => (
              // The link text is only the label, so the link's accessible name is the label.
              // The username, organisation kind and role sit beside it, outside the anchor.
              <LinkCard key={persona.key} href={loginHref(persona)} title={persona.label}>
                <span>{persona.username}</span>
                <Badge tone="info">{persona.orgKind}</Badge>
                <Badge>{persona.role}</Badge>
              </LinkCard>
            ))}
          </LinkCardList>
        ) : (
          <Card tone="error" role="alert">
            {loaded.reason}
          </Card>
        )}
      </Stack>
    </CenteredPage>
  );
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// BOS_DEV_LOGIN_RATE_LIMIT raises the CR-03 login limit for local e2e runs. Production must stay at
// 20, so the variable may only be wired up in the dev overlay, on the workspace service. The app
// itself also refuses it off *.localhost (lib/env.ts); this guards the config files.
const NAME = 'BOS_DEV_LOGIN_RATE_LIMIT';
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe(`${NAME} is dev-only`, () => {
  it.each(['compose.yaml', 'compose.prod.yaml'])('%s does not mention it', (file) => {
    expect(read(`../../../infra/compose/${file}`)).not.toContain(NAME);
  });

  it('compose.dev.yaml sets it once, with a default of 200, on the workspace service only', () => {
    const lines = read('../../../infra/compose/compose.dev.yaml').split(/\r?\n/);
    const hits = lines.flatMap((line, i) => (line.includes(NAME) ? [i] : []));
    const setters = hits.filter((i) => !lines[i]!.trimStart().startsWith('#'));
    expect(setters).toHaveLength(1);
    expect(lines[setters[0]!]!.trim()).toBe(`${NAME}: \${${NAME}:-200}`);
    // The service is the nearest line above that is indented by exactly two spaces.
    const service = lines
      .slice(0, setters[0])
      .reverse()
      .find((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
    expect(service?.trim()).toBe('workspace:');
  });

  it('.env.example only mentions it in a comment, so copying it never turns it on', () => {
    const lines = read('../../../.env.example').split(/\r?\n/);
    const mentions = lines.filter((line) => line.includes(NAME));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) expect(line.startsWith('#')).toBe(true);
  });
});

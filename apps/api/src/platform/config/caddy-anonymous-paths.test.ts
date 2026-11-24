import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The logo paths answer readers with no session (R6Q20b), so the edge proxy bounds them: a body cap and connect and
// response-header timeouts. This reads the Caddyfile text the way compose-timeouts.test.ts reads compose.yaml.
const caddyfile = readFileSync(
  fileURLToPath(new URL('../../../../../infra/caddy/Caddyfile', import.meta.url)),
  'utf8',
);

/** The `handle <matcher> { ... }` block of a site, up to the closing brace at the same indent. */
function handleBlock(matcher: string): string {
  const start = caddyfile.indexOf(`\thandle ${matcher} {`);
  expect(start, `handle ${matcher}`).toBeGreaterThanOrEqual(0);
  const end = caddyfile.indexOf('\n\t}\n', start);
  return caddyfile.slice(start, end);
}

describe('Caddy limits on the anonymous logo paths', () => {
  it('defines bounded upstream timeouts, repeated from node_upstream because a second transport block cannot be imported', () => {
    const snippet = /\(node_upstream_anonymous\) \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? '';
    expect(snippet).toMatch(/dial_timeout\s+\d+s/);
    expect(snippet).toMatch(/response_header_timeout\s+\d+s/);
    expect(snippet).toMatch(/keepalive 3s/);
  });

  it.each(['/brand/logo/*', '/v1/public/*'])(
    '%s caps the request body and uses the bounded upstream',
    (matcher) => {
      const block = handleBlock(matcher);
      expect(block).toMatch(/request_body \{\s*max_size 1KB\s*\}/);
      expect(block).toContain('import node_upstream_anonymous');
    },
  );

  it('serves /brand/logo/* on both web apps', () => {
    expect(caddyfile.match(/\thandle \/brand\/logo\/\* \{/g)).toHaveLength(2);
  });
});

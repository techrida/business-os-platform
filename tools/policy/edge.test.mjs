// Run: node --test tools/policy/edge.test.mjs
// U1-02 edge and environment hardening: HSTS, API allow-list mount, SMTP guard, production start command, blank secrets.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const caddyfile = read('infra/caddy/Caddyfile');
const prod = read('infra/compose/compose.prod.yaml');
const envExample = read('.env.example');

test('the site_tls snippet sets Strict-Transport-Security', () => {
  const snippet = caddyfile.slice(
    caddyfile.indexOf('(site_tls)'),
    caddyfile.indexOf('\n}\n', caddyfile.indexOf('(site_tls)')),
  );
  assert.match(snippet, /header Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
});

test('the API site imports an API allow-list that prod mounts, like auth-restricted.caddy', () => {
  assert.ok(existsSync(new URL('../../infra/caddy/api-restricted.caddy', import.meta.url)));
  assert.match(caddyfile, /import \/etc\/caddy\/api\.d\/\*/);
  assert.match(
    prod,
    /source: \.\.\/caddy\/api-restricted\.caddy\s+target: \/etc\/caddy\/api\.d\/restricted\.caddy\s+read_only: true/,
  );
});

test('the API allow-list answers 404 for everything except the outside callers', () => {
  const restricted = read('infra/caddy/api-restricted.caddy');
  const matcher = restricted.match(/^@api_denied not path (.+)$/m);
  assert.ok(matcher, 'an @api_denied matcher');
  assert.deepEqual(matcher[1].trim().split(/\s+/).sort(), [
    '/health/live',
    '/v1/files/*',
    '/v1/hooks/postal',
    '/v1/hooks/zitadel',
    '/v1/public/*',
  ]);
  assert.match(restricted, /handle @api_denied \{\s*respond 404\s*\}/);
});

test('prod requires SMTP_URL for the api and the worker', () => {
  const guard = 'SMTP_URL: ${SMTP_URL:?set SMTP_URL in .env}';
  for (const service of ['api', 'worker']) {
    const start = prod.indexOf(`\n  ${service}:\n`);
    assert.notEqual(start, -1, `${service} service block`);
    const end = prod.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    const block = prod.slice(start, end === -1 ? undefined : start + 1 + end);
    assert.ok(block.includes(guard), `${service} requires SMTP_URL`);
  }
});

test('the documented prod start command starts ClamAV and names the metrics profile', () => {
  const header = prod.split('\n').slice(0, 6).join('\n');
  assert.match(header, /--profile files/);
  assert.match(header, /--profile obs/);
});

test('the seven secret values in .env.example are blank', () => {
  for (const key of [
    'POSTGRES_PASSWORD',
    'BOS_DB_OWNER_PASSWORD',
    'BOS_DB_APP_PASSWORD',
    'ZITADEL_DB_PASSWORD',
    'ZITADEL_MASTERKEY',
    'ZITADEL_LOGIN_COOKIE_SECRET',
    'ZITADEL_ADMIN_PASSWORD',
  ]) {
    assert.match(envExample, new RegExp(`^${key}=$`, 'm'), `${key} is blank`);
  }
});

test('make-dev-env.sh generates the seven secrets', () => {
  const script = read('infra/scripts/make-dev-env.sh');
  for (const key of [
    'POSTGRES_PASSWORD',
    'BOS_DB_OWNER_PASSWORD',
    'BOS_DB_APP_PASSWORD',
    'ZITADEL_DB_PASSWORD',
    'ZITADEL_MASTERKEY',
    'ZITADEL_LOGIN_COOKIE_SECRET',
    'ZITADEL_ADMIN_PASSWORD',
  ]) {
    assert.match(script, new RegExp(`ensure ${key} `), `${key} is generated`);
  }
});

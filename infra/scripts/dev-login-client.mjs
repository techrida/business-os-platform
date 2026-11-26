#!/usr/bin/env node
// Provision ONLY a disposable local-development ZITADEL instance.
// NODE_ENV=development NODE_EXTRA_CA_CERTS=.dev/caddy-root.crt \
// BOS_DEV_BOOTSTRAP_TOKEN_FILE=.dev/admin.pat \
// BOS_DEV_LOGIN_CLIENT_TOKEN_FILE=.dev/login-client.pat \
// node --env-file=.dev/zitadel.env infra/scripts/dev-login-client.mjs
// Copy admin.pat out of the matching local stack's zitadel-admin volume first; never print it.
// Set BOS_DEV_LOGIN_CLIENT_TOKEN_FILE in the next dev process, then restart it.
import { readFile, writeFile } from 'node:fs/promises';

const issuer = new URL(process.env.OIDC_ISSUER ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'development' ||
  (!['localhost'].includes(issuer.hostname) &&
    !issuer.hostname.endsWith('.localhost') &&
    !issuer.hostname.endsWith('.bos.test'))
)
  throw new Error('Only local development is supported');
const output = process.env.BOS_DEV_LOGIN_CLIENT_TOKEN_FILE;
if (!output || !process.env.ZITADEL_STAFF_ORG_ID)
  throw new Error('Token output path and development staff organization are required');
const admin = (await readFile(process.env.BOS_DEV_BOOTSTRAP_TOKEN_FILE, 'utf8')).trim();
async function call(path, body) {
  const response = await fetch(new URL(path, issuer), {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${admin}`,
      'content-type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Development provisioning failed (${response.status})`);
  return response.json();
}
const username = 'bos-dev-login-client';
const users = await call('/zitadel.user.v2.UserService/ListUsers', {
  queries: [{ userNameQuery: { userName: username, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
});
let id = users.result?.find(
  (user) => user.details.resourceOwner === process.env.ZITADEL_STAFF_ORG_ID && user.machine,
)?.userId;
if (!id) {
  const created = await call('/zitadel.user.v2.UserService/CreateUser', {
    organizationId: process.env.ZITADEL_STAFF_ORG_ID,
    username,
    machine: {
      name: 'Local development account switcher',
      accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
    },
  });
  id = created.id;
}
if (!id) throw new Error('Missing development login client id');
const members = await call('/admin/v1/members/_search', {});
if (
  !members.result?.some(
    (member) => member.userId === id && member.roles.includes('IAM_LOGIN_CLIENT'),
  )
)
  await call('/admin/v1/members', { userId: id, roles: ['IAM_LOGIN_CLIENT'] });
const pat = await call(`/management/v1/users/${encodeURIComponent(id)}/pats`, {
  expirationDate: new Date(Date.now() + 30 * 86400000).toISOString(),
});
await writeFile(output, pat.token, { mode: 0o600, flag: 'wx' });
console.log(
  'Dedicated local development login client configured. Token written to protected file; restart next dev with BOS_DEV_LOGIN_CLIENT_TOKEN_FILE.',
);

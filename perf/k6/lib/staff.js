/* global __ENV, open */
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check, fail } from 'k6';

function localOrigin(value) {
  if (
    !/^https?:\/\/(?:[a-z0-9-]+\.)*localhost(?::\d+)?$|^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(
      value,
    )
  )
    throw new Error('Perf runs require a local origin');
  return value;
}

const api = localOrigin(__ENV.K6_API_BASE_URL || 'https://api.localhost');
const issuer = localOrigin(__ENV.OIDC_ISSUER || 'https://auth.localhost');
export const manifest = JSON.parse(open(__ENV.K6_PERF_MANIFEST || '/perf-manifest.json'));

export function staffToken(role) {
  const prefix = 'K6_PERF_' + role.toUpperCase();
  const id = __ENV[prefix + '_CLIENT_ID'];
  const secret = __ENV[prefix + '_CLIENT_SECRET'];
  const project = __ENV.K6_PROJECT_ID;
  if (!id || !secret || !project) fail('Missing perf credentials for ' + role);
  const basic = encoding.b64encode(encodeURIComponent(id) + ':' + encodeURIComponent(secret));
  const res = http.post(
    issuer + '/oauth/v2/token',
    {
      grant_type: 'client_credentials',
      scope:
        'openid urn:zitadel:iam:org:project:id:' +
        project +
        ':aud urn:zitadel:iam:org:projects:roles urn:zitadel:iam:user:resourceowner',
    },
    { headers: { Authorization: 'Basic ' + basic }, redirects: 0, tags: { name: 'setup-token' } },
  );
  if (res.status !== 200) fail('Perf token request failed for ' + role + ': ' + res.status);
  const token = res.json('access_token');
  const me = request(token, 'setup-me', 'GET', '/v1/me', null, 200).json();
  if (
    !manifest.staff[role] ||
    me.id !== manifest.staff[role] ||
    me.tenantId !== manifest.tenantId ||
    me.organizationId !== manifest.organizationId ||
    !me.roles.includes(role)
  )
    fail('Unexpected perf identity for ' + role);
  return token;
}

export function request(token, flow, method, path, body, status, key) {
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'X-Entity-Id': manifest.organizationId,
  };
  if (key) headers['Idempotency-Key'] = key;
  const res = http.request(method, api + path, body == null ? null : JSON.stringify(body), {
    headers,
    redirects: 0,
    tags: { name: flow, flow },
  });
  if (!check(res, { [flow]: (r) => r.status === status }, { flow }))
    fail(flow + ' returned HTTP ' + res.status);
  return res;
}

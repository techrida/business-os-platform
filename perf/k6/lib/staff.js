/* global __ENV */
import http from 'k6/http';
import encoding from 'k6/encoding';
import { SharedArray } from 'k6/data';
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
// Full-scale manifests contain over 100,000 IDs. Keep those arrays once per process.
function loadManifest() {
  let parsed;
  const read = () => (parsed ??= JSON.parse(open(__ENV.K6_PERF_MANIFEST || '/perf-manifest.json')));
  const [metadata] = new SharedArray('perf-company', () => {
    const { ids, ...company } = read();
    const arrays = Object.keys(company).filter((key) => Array.isArray(company[key]));
    const fields = Object.fromEntries(
      Object.entries(company).filter(([key]) => !arrays.includes(key)),
    );
    return [{ fields, arrays, tables: Object.keys(ids) }];
  });
  const manifest = { ...metadata.fields, ids: {} };
  for (const name of metadata.arrays)
    manifest[name] = new SharedArray('perf-company-' + name, () => read()[name]);
  for (const table of metadata.tables)
    manifest.ids[table] = new SharedArray('perf-ids-' + table, () => read().ids[table]);
  return manifest;
}
export const manifest = loadManifest();

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

export function request(
  token,
  flow,
  method,
  path,
  body,
  status,
  key,
  contentType = 'application/json',
) {
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': contentType,
    'X-Entity-Id': manifest.organizationId,
    'X-Perf-Flow': flow,
  };
  if (key) headers['Idempotency-Key'] = key;
  const res = http.request(
    method,
    api + path,
    body == null || contentType !== 'application/json' ? body : JSON.stringify(body),
    {
      headers,
      redirects: 0,
      tags: { name: flow, flow },
    },
  );
  if (!check(res, { [flow]: (r) => r.status === status }, { flow })) {
    let code;
    try {
      code = res.json('error.code');
    } catch {
      code = undefined;
    }
    fail(
      flow +
        ' returned HTTP ' +
        res.status +
        (typeof code === 'string' && /^[a-z_]{1,64}$/i.test(code) ? ' (' + code + ')' : ''),
    );
  }
  return res;
}

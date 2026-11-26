// Policy test (U1-01): which compose services can see the identity credentials.
// Run: node --test tools/policy/compose-secrets.test.mjs
//
// Reads infra/compose/*.yaml with a small YAML reader (block maps, block lists, flow lists, anchors, aliases,
// comments, block scalars). No dependencies, so it runs before `pnpm install`. The compose files here use no
// other YAML feature; the reader throws on a line it cannot place, so a new feature fails loudly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const composeDir = new URL('../../infra/compose/', import.meta.url);

// ---------------------------------------------------------------- YAML subset reader

function stripComment(text) {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function scalar(raw, anchors) {
  const text = raw.trim();
  if (text.startsWith('*')) {
    if (!anchors.has(text.slice(1))) throw new Error(`unknown alias ${text}`);
    return anchors.get(text.slice(1));
  }
  if (text === '{}') return {};
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    return inner === ''
      ? []
      : (inner.match(/(?:[^,'"]+|'[^']*'|"[^"]*")+/g) ?? []).map((w) => scalar(w, anchors));
  }
  return text.replace(/^(["'])(.*)\1$/, '$2');
}

function parseYaml(source) {
  const rawLines = source.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (/^\s*(#.*)?$/.test(raw)) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), raw, no: i + 1 });
  }
  const anchors = new Map();
  let pos = 0;

  function blockScalar(parentIndent) {
    // Raw lines deeper than the parent, including blank and comment-looking ones, belong to the scalar.
    const first = lines[pos - 1].no; // line number (1-based) of the key line
    let at = first; // index into rawLines of the line after the key
    const body = [];
    while (at < rawLines.length) {
      const raw = rawLines[at];
      const indent = raw.length - raw.trimStart().length;
      if (raw.trim() !== '' && indent <= parentIndent) break;
      body.push(raw);
      at += 1;
    }
    while (pos < lines.length && lines[pos].no <= at) pos += 1;
    return body.join('\n');
  }

  function node(indent) {
    const line = lines[pos];
    if (!line || line.indent < indent) return null;
    return line.text.startsWith('- ') || line.text === '-' ? list(line.indent) : map(line.indent);
  }

  /** A `[ ... ]` list written over several lines. */
  function flowList() {
    let text = '';
    do {
      text += ` ${stripComment(lines[pos].text)}`;
      pos += 1;
    } while (!text.trimEnd().endsWith(']') && pos < lines.length);
    return scalar(text, anchors);
  }

  function value(rest, parentIndent) {
    const text = stripComment(rest);
    let anchor;
    let body = text;
    const a = /^&(\S+)\s*(.*)$/.exec(body);
    if (a) {
      anchor = a[1];
      body = a[2];
    }
    let result;
    if (body === '' && lines[pos]?.text.startsWith('[') && lines[pos].indent > parentIndent) {
      result = flowList();
    } else if (body === '') {
      const next = lines[pos];
      if (
        next &&
        (next.indent > parentIndent || (next.indent === parentIndent && /^-( |$)/.test(next.text)))
      ) {
        result = node(next.indent);
      } else {
        result = null;
      }
    } else if (body === '|' || body === '>' || /^[|>][+-]?$/.test(body)) {
      result = blockScalar(parentIndent);
    } else {
      result = scalar(body, anchors);
    }
    if (anchor) anchors.set(anchor, result);
    return result;
  }

  function map(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent && !/^-( |$)/.test(lines[pos].text)) {
      const line = lines[pos];
      const m = /^("[^"]*"|'[^']*'|[^\s:][^:]*?):(?:\s+(.*))?$/.exec(stripComment(line.text));
      if (!m) throw new Error(`cannot read line ${line.no}: ${line.text}`);
      pos += 1;
      const key = m[1].replace(/^(["'])(.*)\1$/, '$2');
      if (key === '<<') {
        const merged = scalar(m[2] ?? '', anchors);
        Object.assign(out, merged);
      } else {
        out[key] = value(m[2] ?? '', indent);
      }
    }
    return out;
  }

  function list(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && /^-( |$)/.test(lines[pos].text)) {
      const line = lines[pos];
      const rest = line.text.replace(/^-\s*/, '');
      const offset = line.text.length - rest.length;
      if (rest === '') {
        pos += 1;
        out.push(node(indent + 1));
      } else if (/^("[^"]*"|'[^']*'|[^\s:'"*&[{][^:]*?):(\s|$)/.test(stripComment(rest))) {
        // `- key: value`: the item is a map whose first line is the rest of this one.
        lines[pos] = { ...line, indent: indent + offset, text: rest };
        out.push(map(indent + offset));
      } else {
        pos += 1;
        out.push(value(rest, indent));
      }
    }
    return out;
  }

  const root = node(0);
  if (pos < lines.length) throw new Error(`unparsed content from line ${lines[pos].no}`);
  return root ?? {};
}

// ---------------------------------------------------------------- helpers

const load = (name) => parseYaml(readFileSync(new URL(name, composeDir), 'utf8'));
const base = load('compose.yaml');
const overlays = {
  'compose.dev.yaml': load('compose.dev.yaml'),
  'compose.prod.yaml': load('compose.prod.yaml'),
};
const allFiles = { 'compose.yaml': base, ...overlays };

const service = (file, name) => file.services?.[name] ?? {};
const envFiles = (svc) =>
  (svc.env_file ?? [])
    .map((e) => (typeof e === 'string' ? e : e.path))
    .map((p) => p.split('/').pop());
const mounts = (svc) =>
  (svc.volumes ?? []).map((v) => {
    if (typeof v === 'string') return { source: v.split(':')[0], target: v.split(':')[1] };
    return { source: v.source, target: v.target };
  });
const userOf = (svc) => (svc.user === undefined ? undefined : String(svc.user));
const isRoot = (user) => user !== undefined && /^(0|root)(:|$)/.test(user);
const envKeys = (svc) => {
  const env = svc.environment ?? {};
  return Array.isArray(env) ? env.map((e) => e.split('=')[0]) : Object.keys(env);
};

// ---------------------------------------------------------------- the reader itself

test('the YAML reader understands the shapes the compose files use', () => {
  const doc = parseYaml(
    [
      'x-mount: &m',
      '  type: bind',
      '  source: a',
      'services:',
      '  web:',
      '    env_file:',
      '      - path: ../x.env # comment',
      '        required: false',
      '    volumes:',
      '      - *m',
      '      - data:/var/x:ro',
      '    networks: [edge, backend]',
      '    cmd: |',
      '      keep # this',
      '',
      '      and this',
      '  other:',
      '    user: "0"',
    ].join('\n'),
  );
  assert.deepEqual(doc.services.web.env_file, [{ path: '../x.env', required: 'false' }]);
  assert.deepEqual(doc.services.web.volumes, [{ type: 'bind', source: 'a' }, 'data:/var/x:ro']);
  assert.deepEqual(doc.services.web.networks, ['edge', 'backend']);
  assert.match(doc.services.web.cmd, /keep # this\n\n\s+and this/);
  assert.equal(doc.services.other.user, '0');
});

test('the reader finds the services the rules below depend on', () => {
  for (const name of [
    'api',
    'worker',
    'workspace',
    'portal',
    'zitadel-api',
    'zitadel-login',
    'seed-zitadel',
    'clamav',
  ]) {
    assert.ok(base.services?.[name], `compose.yaml has no service ${name}`);
  }
});

// ---------------------------------------------------------------- the rules

test('only api and worker read the provisioner token file', () => {
  for (const [file, doc] of Object.entries(allFiles)) {
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      const reads = envFiles(svc).includes('zitadel-api.env');
      const allowed = name === 'api' || name === 'worker';
      assert.equal(reads && !allowed, false, `${file}: ${name} reads zitadel-api.env`);
    }
  }
  for (const name of ['api', 'worker']) {
    assert.ok(
      envFiles(service(base, name)).includes('zitadel-api.env'),
      `${name} must read zitadel-api.env`,
    );
    assert.ok(
      envFiles(service(base, name)).includes('zitadel.env'),
      `${name} must keep zitadel.env (ids)`,
    );
  }
});

test('workspace and portal cannot see the provisioner token or signing key', () => {
  for (const [file, doc] of Object.entries(allFiles)) {
    for (const name of ['workspace', 'portal']) {
      const svc = service(doc, name);
      assert.equal(
        envFiles(svc).includes('zitadel-api.env'),
        false,
        `${file}: ${name} reads zitadel-api.env`,
      );
      for (const key of envKeys(svc)) {
        assert.doesNotMatch(
          key,
          /^ZITADEL_(PROVISIONER_TOKEN|ACTIONS_SIGNING_KEY)$/,
          `${file}: ${name} sets ${key}`,
        );
      }
      assert.ok(
        mounts(svc).every((m) => m.source !== 'zitadel-admin' && m.source !== 'zitadel-bootstrap'),
        `${file}: ${name} mounts an identity volume`,
      );
    }
  }
  assert.ok(envFiles(service(base, 'workspace')).includes('zitadel.env'));
  assert.ok(envFiles(service(base, 'portal')).includes('zitadel.env'));
});

test('the admin token volume is mounted in zitadel-api and seed-zitadel only', () => {
  assert.ok(
    'zitadel-admin' in (base.volumes ?? {}),
    'compose.yaml declares no zitadel-admin volume',
  );
  const holders = [];
  for (const [file, doc] of Object.entries(allFiles)) {
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      if (mounts(svc).some((m) => m.source === 'zitadel-admin')) holders.push(`${file}:${name}`);
    }
  }
  assert.deepEqual(holders.sort(), ['compose.yaml:seed-zitadel', 'compose.yaml:zitadel-api']);
});

test('admin.pat lives in the admin volume; the login client token stays in the bootstrap volume', () => {
  const api = service(base, 'zitadel-api');
  const adminMount = mounts(api).find((m) => m.source === 'zitadel-admin');
  assert.ok(adminMount, 'zitadel-api does not mount zitadel-admin');
  assert.equal(api.environment.ZITADEL_FIRSTINSTANCE_PATPATH, `${adminMount.target}/admin.pat`);
  const bootstrapMount = mounts(api).find((m) => m.source === 'zitadel-bootstrap');
  assert.ok(bootstrapMount, 'zitadel-api does not mount zitadel-bootstrap');
  assert.equal(
    api.environment.ZITADEL_FIRSTINSTANCE_LOGINCLIENTPATPATH,
    `${bootstrapMount.target}/login-client.pat`,
  );

  const seed = service(base, 'seed-zitadel');
  const seedMount = mounts(seed).find((m) => m.source === 'zitadel-admin');
  assert.ok(seedMount, 'seed-zitadel does not mount zitadel-admin');
  assert.equal(seed.environment.ZITADEL_ADMIN_PAT_FILE, `${seedMount.target}/admin.pat`);
  assert.equal(
    mounts(seed).some((m) => m.source === 'zitadel-bootstrap'),
    false,
    'seed-zitadel has no reason to read the login client token',
  );
});

test('zitadel-login does not run as root and does not see the admin volume', () => {
  for (const [file, doc] of Object.entries(allFiles)) {
    const svc = service(doc, 'zitadel-login');
    assert.equal(isRoot(userOf(svc)), false, `${file}: zitadel-login runs as uid 0`);
    assert.equal(
      mounts(svc).some((m) => m.source === 'zitadel-admin'),
      false,
      `${file}: zitadel-login mounts zitadel-admin`,
    );
  }
  const login = service(base, 'zitadel-login');
  assert.ok(
    mounts(login).some((m) => m.source === 'zitadel-bootstrap'),
    'zitadel-login still reads login-client.pat from zitadel-bootstrap',
  );
});

test('workspace and portal do not run as root', () => {
  for (const name of ['workspace', 'portal']) {
    assert.equal(isRoot(userOf(service(base, name))), false, `${name} runs as uid 0`);
  }
});

test('clamav is not on the edge network and has an egress-only network for signature updates', () => {
  for (const [file, doc] of Object.entries(allFiles)) {
    const nets = service(doc, 'clamav').networks;
    if (nets === undefined) continue;
    const names = Array.isArray(nets) ? nets : Object.keys(nets);
    assert.equal(names.includes('edge'), false, `${file}: clamav is on edge`);
  }
  const nets = service(base, 'clamav').networks;
  const names = Array.isArray(nets) ? nets : Object.keys(nets ?? {});
  assert.ok(names.includes('backend'), 'api and worker reach clamav over backend');
  const egress = names.filter((n) => n !== 'backend');
  assert.equal(
    egress.length,
    1,
    `clamav should have exactly one outbound network, has ${egress.join(', ')}`,
  );
  const net = base.networks?.[egress[0]];
  assert.ok(net !== undefined, `network ${egress[0]} is not declared`);
  assert.notEqual(
    String(net?.internal),
    'true',
    `${egress[0]} must have a route out for freshclam`,
  );
  for (const [name, svc] of Object.entries(base.services)) {
    if (name === 'clamav') continue;
    const other = svc.networks ?? [];
    const otherNames = Array.isArray(other) ? other : Object.keys(other);
    assert.equal(otherNames.includes(egress[0]), false, `${name} shares the clamav egress network`);
  }
});

test('the worker does not hold the document link secret', () => {
  assert.equal(envKeys(service(base, 'worker')).includes('DOCS_LINK_SECRET'), false);
  assert.ok(
    envKeys(service(base, 'api')).includes('DOCS_LINK_SECRET'),
    'api still signs the links',
  );
});

test('clamd refuses the SHUTDOWN command from the network', () => {
  const conf = readFileSync(new URL('../../infra/clamav/clamd.conf', import.meta.url), 'utf8');
  assert.match(conf, /^EnableShutdownCommand no$/m);
});

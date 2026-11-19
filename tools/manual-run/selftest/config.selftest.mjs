// Run: node --test 'tools/manual-run/selftest/*.selftest.mjs'
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import {
  checkOrigin,
  loadConfig,
  normaliseLabel,
  runKeyFor,
  runMatch,
  uniqueValues,
} from '../lib/config.mjs';

describe('run labels', () => {
  test('are lower-cased, so SCR1 and scr1 are one label with one run key', () => {
    assert.equal(normaliseLabel('SCR1'), 'scr1');
    assert.equal(normaliseLabel(' scr1 '), 'scr1');
    const a = uniqueValues(`${normaliseLabel('SCR1')}-1440`);
    const b = uniqueValues('scr1-1440');
    assert.deepEqual(
      [a.suffix, a.pan, a.emailLocal, a.bankRef(1)],
      [b.suffix, b.pan, b.emailLocal, b.bankRef(1)],
    );
  });

  test('refuse dashes, other characters, empty and over-long labels', () => {
    for (const bad of ['x-1440', 'a b', 'a_b', 'é1', '', undefined, 'a'.repeat(25)])
      assert.throws(() => normaliseLabel(bad), /letters and digits only/, String(bad));
    assert.equal(normaliseLabel('a'.repeat(24)), 'a'.repeat(24));
  });

  test('run keys have a fixed form, so one is never the start of another', () => {
    assert.equal(runKeyFor('scr1', 1440), 'scr1-1440');
    assert.equal(runKeyFor('scr1', 390), 'scr1-0390');
    const keys = [];
    for (const label of ['x', 'x1', 'ax', 'x14', 'scr1'])
      for (const width of [144, 390, 820, 1440]) keys.push(`SCR-${runKeyFor(label, width)}`);
    for (const a of keys)
      for (const b of keys) if (a !== b) assert.ok(!b.includes(a), `${a} is inside ${b}`);
  });

  test('a name is found in a row whose next cell follows it directly, and is case-sensitive', () => {
    const mine = runMatch(`BOS Demo Himalayan Labs SCR-${runKeyFor('ab', 1440)}`);
    assert.ok(mine.test('BOS Demo Himalayan Labs SCR-ab-1440'));
    assert.ok(mine.test('RCPT-1BOS Demo Himalayan Labs SCR-ab-1440Verified'));
    assert.ok(mine.test('BOS Demo Himalayan Labs SCR-ab-1440Dev Sales'));
    assert.ok(!mine.test(`BOS Demo Himalayan Labs SCR-${runKeyFor('ab', 144)}`));
    assert.ok(!mine.test('BOS Demo Himalayan Labs SCR-AB-1440'));
  });

  test('a label is not matched inside a longer label', () => {
    const x = runMatch(`Labs SCR-${runKeyFor(normaliseLabel('x'), 1440)}`);
    assert.ok(!x.test(`Labs SCR-${runKeyFor(normaliseLabel('ax'), 1440)}`));
    assert.ok(!x.test(`Labs SCR-${runKeyFor(normaliseLabel('x1'), 1440)}`));
  });

  test('regular-expression characters in the text are literal', () => {
    assert.ok(runMatch('QT-2083/84-00006').test('QT-2083/84-00006 Rev 1'));
    assert.ok(!runMatch('a.b').test('axb'));
  });
});

describe('origin guard', () => {
  test('accepts https origins on local development hosts', () => {
    for (const ok of [
      'https://app.testrun.localhost:58343',
      'https://localhost',
      'https://127.0.0.1:8443',
      'https://app.p1.bos.test',
      'https://APP.TESTRUN.LOCALHOST:58343/',
    ])
      assert.match(checkOrigin('APP_URL', ok), /^https:\/\//, ok);
    assert.equal(
      checkOrigin('APP_URL', 'https://app.testrun.localhost:58343/'),
      'https://app.testrun.localhost:58343',
    );
  });

  test('refuses public hosts and look-alikes', () => {
    for (const bad of [
      'https://example.com',
      'https://app.localhost.evil.com',
      'https://app.bos.test.evil.com',
      'https://evillocalhost',
      'https://127.0.0.1.nip.io',
      'https://bos.test',
      'https://[::1]',
    ])
      assert.throws(() => checkOrigin('APP_URL', bad), /not a local development host/, bad);
  });

  test('judges the real host, not text in the user name', () => {
    assert.throws(
      () => checkOrigin('APP_URL', 'https://app.localhost@evil.com'),
      /user name|not a local/,
    );
  });

  test('refuses http, paths, queries and credentials', () => {
    assert.throws(() => checkOrigin('APP_URL', 'http://app.testrun.localhost:58343'), /https/);
    assert.throws(() => checkOrigin('APP_URL', 'https://app.localhost/x'), /origin only/);
    assert.throws(() => checkOrigin('APP_URL', 'https://app.localhost/?a=1'), /origin only/);
    assert.throws(() => checkOrigin('APP_URL', 'https://u:p@app.localhost'), /user name/);
    assert.throws(() => checkOrigin('APP_URL', 'not a url'), /not a URL/);
  });

  test('ALLOW_NON_LOCAL_TARGET allows a public https host but never http', () => {
    assert.equal(
      checkOrigin('APP_URL', 'https://example.com', { allowNonLocal: true }),
      'https://example.com',
    );
    assert.throws(
      () => checkOrigin('APP_URL', 'http://example.com', { allowNonLocal: true }),
      /https/,
    );
  });
});

describe('loadConfig', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'manual-run-selftest-'));
  const personas = path.join(dir, 'personas.json');
  writeFileSync(personas, '[]');
  writeFileSync(path.join(dir, 'caddy-root.crt'), 'not read by loadConfig');
  const keys = [
    'APP_URL',
    'PORTAL_URL',
    'MAIL_URL',
    'AUTH_URL',
    'PERSONAS_FILE',
    'CA_FILE',
    'NODE_EXTRA_CA_CERTS',
    'ALLOW_NON_LOCAL_TARGET',
    'RUN_LABEL',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  beforeEach(() => {
    for (const k of keys) delete process.env[k];
    process.env.PERSONAS_FILE = personas;
  });
  after(() => {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    rmSync(dir, { recursive: true, force: true });
  });

  test('defaults to the local test stack, derives AUTH_URL and lower-cases the label', () => {
    const cfg = loadConfig({ label: 'FIX1', viewport: '1440x900' });
    assert.equal(cfg.label, 'fix1');
    assert.equal(cfg.runKey, 'fix1-1440');
    assert.equal(cfg.authUrl, 'https://auth.testrun.localhost:58343');
    assert.equal(cfg.caFile, path.join(dir, 'caddy-root.crt'));
  });

  test('refuses a public APP_URL unless ALLOW_NON_LOCAL_TARGET=1', () => {
    process.env.APP_URL = 'https://app.example.com';
    assert.throws(() => loadConfig({ label: 'x' }), /APP_URL host app\.example\.com/);
    process.env.ALLOW_NON_LOCAL_TARGET = 'yes';
    assert.throws(() => loadConfig({ label: 'x' }), /APP_URL/, 'only the exact value 1 allows it');
    process.env.ALLOW_NON_LOCAL_TARGET = '1';
    assert.equal(loadConfig({ label: 'x' }).appUrl, 'https://app.example.com');
  });

  test('checks every origin, including a derived AUTH_URL', () => {
    process.env.MAIL_URL = 'http://mail.testrun.localhost:58343';
    assert.throws(() => loadConfig({ label: 'x' }), /MAIL_URL must use https/);
    delete process.env.MAIL_URL;
    process.env.AUTH_URL = 'https://login.example.com';
    assert.throws(() => loadConfig({ label: 'x' }), /AUTH_URL/);
  });

  test('never falls back to NODE_EXTRA_CA_CERTS for the CA', () => {
    process.env.PERSONAS_FILE = path.join(dir, 'elsewhere', 'personas.json');
    process.env.NODE_EXTRA_CA_CERTS = personas; // exists, but must not be used
    assert.throws(() => loadConfig({ label: 'x' }), /CA file .* not found/);
    process.env.CA_FILE = path.join(dir, 'caddy-root.crt');
    assert.equal(loadConfig({ label: 'x' }).caFile, process.env.CA_FILE);
  });
});

// URL redaction, shell-safe launcher paths, network-isolation choice and step time limits.
// Run: node --test 'tools/manual-run/selftest/*.selftest.mjs'
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertShellSafePath, netnsWanted, shq } from '../lib/netns.mjs';
import { redactText, redactUrl } from '../lib/redact.mjs';
import { withTimeout } from '../lib/runner.mjs';
import { StepFailure } from '../lib/session.mjs';

describe('URL redaction', () => {
  test('drops the query string and fragment of a URL', () => {
    assert.equal(
      redactUrl('https://app.localhost/auth/callback?code=123456&state=abc#frag'),
      'https://app.localhost/auth/callback',
    );
    assert.equal(redactUrl('https://app.localhost/inbox'), 'https://app.localhost/inbox');
    assert.equal(redactUrl('/payments/x?q=a'), '/payments/x');
    assert.equal(redactUrl(undefined), '');
  });

  test('cleans every URL inside free text and leaves other text alone', () => {
    const text =
      'page.goto: net::ERR_FAILED at https://auth.localhost/cb?code=999&state=s1 then ' +
      'http://x.localhost/a#tok and "https://app.localhost/p?x=1" (3 = 3?)';
    const out = redactText(text);
    assert.ok(!/code=|state=|#tok|x=1/.test(out), out);
    assert.match(out, /https:\/\/auth\.localhost\/cb then/);
    assert.match(out, /http:\/\/x\.localhost\/a and/);
    assert.match(out, /"https:\/\/app\.localhost\/p"/);
    assert.match(out, /\(3 = 3\?\)$/);
  });
});

describe('shell-safe paths', () => {
  test('accepts plain absolute paths', () => {
    for (const ok of [
      '/home/crestia/bos-runtimes/manual-run/scr1/1440x900/.net',
      '/home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome',
    ])
      assert.equal(assertShellSafePath(ok, 'x'), ok);
  });

  test('refuses anything a shell or socat could read as syntax', () => {
    for (const bad of [
      'relative/path',
      '/a b',
      '/a"b',
      "/a'b",
      '/a$(id)',
      '/a`id`',
      '/a;rm',
      '/a,fork',
      '/a:b',
      '/a\nb',
      '',
      undefined,
    ])
      assert.throws(() => assertShellSafePath(bad, 'VIDEO_DIR'), /VIDEO_DIR must be/, String(bad));
  });

  test('single-quotes for the shell', () => {
    assert.equal(shq('/a/b'), "'/a/b'");
    assert.equal(shq("/a'b"), "'/a'\\''b'");
  });
});

describe('network isolation choice', () => {
  const local = ['https://app.testrun.localhost:58343', 'https://127.0.0.1:1'];
  test('NETNS=0 turns it off for any origin', () => {
    assert.equal(netnsWanted(['https://app.p1.bos.test'], '0'), false);
  });
  test('never turns itself off silently for a non-loopback origin', () => {
    for (const mode of ['auto', '1'])
      assert.throws(
        () => netnsWanted([...local, 'https://app.p1.bos.test'], mode),
        /NETNS=0/,
        mode,
      );
  });
  test('loopback origins are allowed in auto mode', () => {
    assert.equal(typeof netnsWanted(local, 'auto'), 'boolean');
  });
});

describe('step time limit', () => {
  test('cancels the step first, then fails with the time-limit message', async () => {
    const order = [];
    const never = new Promise(() => {});
    await assert.rejects(
      withTimeout(never, 20, 'sales-7 did not finish within 0.02 s', async () => {
        order.push('cancel');
      }),
      (e) => e instanceof StepFailure && /did not finish/.test(e.message),
    );
    assert.deepEqual(order, ['cancel']);
  });
  test('a step that finishes in time is not cancelled', async () => {
    let cancelled = false;
    assert.equal(
      await withTimeout(Promise.resolve('done'), 50, 'x', () => (cancelled = true)),
      'done',
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cancelled, false);
  });
});

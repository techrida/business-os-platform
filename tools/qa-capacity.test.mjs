import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shardCount } from './qa-capacity.mjs';

test('reserves two slots, respects the benchmark ceiling and degrades on unknown capacity', () => {
  assert.deepEqual(
    [0, 5, 12, 17, 19, undefined].map((n) => shardCount(n)),
    [14, 13, 6, 1, 1, 4],
  );
  assert.equal(shardCount(0, 10), 10);
});

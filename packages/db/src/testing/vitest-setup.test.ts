import pg from 'pg';
import { describe, expect, it } from 'vitest';

describe('vitest setup: a database dropped under an idle pool', () => {
  const fatal = (code: string) => Object.assign(new Error('terminating connection'), { code });

  it('does not fail the run for 57P01 on a pool without an error listener', () => {
    const pool = new pg.Pool();
    expect(() => pool.emit('error', fatal('57P01'))).not.toThrow();
  });

  it('still throws every other error on a pool without a listener', () => {
    const pool = new pg.Pool();
    expect(() => pool.emit('error', fatal('08006'))).toThrow('terminating connection');
  });

  it('still delivers 57P01 to a pool that listens', () => {
    const pool = new pg.Pool();
    const seen: unknown[] = [];
    pool.on('error', (error) => seen.push(error));
    pool.emit('error', fatal('57P01'));
    expect(seen).toHaveLength(1);
  });
});

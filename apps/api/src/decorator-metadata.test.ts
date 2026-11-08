import 'reflect-metadata';

import { Injectable } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

@Injectable()
class Dep {}

@Injectable()
class Svc {
  constructor(readonly dep: Dep) {}
}

// Nest dependency injection reads `design:paramtypes`. esbuild/oxc drop it, SWC keeps it.
// If this test fails, the Vitest + unplugin-swc pairing is broken: pin vitest and
// @vitest/coverage-v8 to 4.1.12 in pnpm-workspace.yaml and re-run.
describe('decorator metadata under Vitest', () => {
  it('emits design:paramtypes for an injectable constructor', () => {
    const paramTypes: unknown = Reflect.getMetadata('design:paramtypes', Svc);
    expect(paramTypes).toEqual([Dep]);
  });
});

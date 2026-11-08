import type { Permission } from '@bos/contracts';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { ANY_AUTHENTICATED_KEY, AnyAuthenticated, Can, CAN_KEY } from './decorators';

@Can('memo.read')
class MemoController {
  list(): void {}

  @Can('memo.update')
  update(): void {}
}

@AnyAuthenticated()
class MeController {
  me(): void {}
}

class MixedController {
  @AnyAuthenticated()
  open(): void {}

  @Can('audit.read')
  audit(): void {}

  bare(): void {}
}

const reflector = new Reflector();
// The same lookup the interceptor and the route sweep use: the handler first, then its class.
const read = <T>(key: string, cls: new () => object, method: string): T | undefined =>
  reflector.getAllAndOverride<T>(key, [
    (cls.prototype as Record<string, () => void>)[method] as () => void,
    cls,
  ]);

describe('@Can', () => {
  it('on a class covers its methods', () => {
    expect(read<Permission>(CAN_KEY, MemoController, 'list')).toBe('memo.read');
  });

  it('on a method overrides the class', () => {
    expect(read<Permission>(CAN_KEY, MemoController, 'update')).toBe('memo.update');
  });

  it('on a method applies to that method only', () => {
    expect(read<Permission>(CAN_KEY, MixedController, 'audit')).toBe('audit.read');
    expect(read<Permission>(CAN_KEY, MixedController, 'open')).toBeUndefined();
  });

  it('throws on a permission that is not in PERMISSIONS', () => {
    expect(() => Can('memo.delete' as Permission)).toThrow(/unknown permission/);
  });
});

describe('@AnyAuthenticated', () => {
  it('on a class covers its methods', () => {
    expect(read<boolean>(ANY_AUTHENTICATED_KEY, MeController, 'me')).toBe(true);
  });

  it('on a method applies to that method only', () => {
    expect(read<boolean>(ANY_AUTHENTICATED_KEY, MixedController, 'open')).toBe(true);
    expect(read<boolean>(ANY_AUTHENTICATED_KEY, MixedController, 'audit')).toBeUndefined();
  });

  it('leaves an undecorated method with neither key, which the interceptor denies', () => {
    expect(read(CAN_KEY, MixedController, 'bare')).toBeUndefined();
    expect(read(ANY_AUTHENTICATED_KEY, MixedController, 'bare')).toBeUndefined();
  });
});

import { MeResponseSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { API_SERVICE_NAME } from './index';

describe('@bos/api skeleton', () => {
  it('exports its service name', () => {
    expect(API_SERVICE_NAME).toBe('bos-api');
  });

  it('resolves @bos/contracts through the vitest alias', () => {
    expect(MeResponseSchema.safeParse({}).success).toBe(false);
  });
});

import { VitalsSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { WORKSPACE_APP_NAME } from './index';

describe('@bos/workspace skeleton', () => {
  it('exports its app name', () => {
    expect(WORKSPACE_APP_NAME).toBe('@bos/workspace');
  });

  it('resolves @bos/contracts through the vitest alias', () => {
    expect(VitalsSchema.safeParse({}).success).toBe(false);
  });
});

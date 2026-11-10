import 'server-only';

import { WithholdingCodeSchema, type WithholdingCode } from '@bos/contracts';
import { z } from 'zod';

import { call } from './api-procurement';
import type { Session } from './session';

/** Bill-entry lookup; the server supplies the effective payable withholding periods. */
export function listWithholdingCodes(session: Session): Promise<WithholdingCode[]> {
  return call(session, '/v1/withholding-codes', z.array(WithholdingCodeSchema));
}

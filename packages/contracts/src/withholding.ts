import { z } from 'zod';

/** Tenant-level, effective-dated TDS codes available to payable bill entry. */
export const WithholdingCodeSchema = z.object({
  id: z.guid(),
  code: z.string(),
  name: z.string(),
  rateBp: z.number().int().min(0).max(10000),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable(),
});
export type WithholdingCode = z.infer<typeof WithholdingCodeSchema>;

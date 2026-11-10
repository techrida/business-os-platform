import { z } from 'zod';

export const CostCenterSchema = z.object({
  id: z.guid(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type CostCenter = z.infer<typeof CostCenterSchema>;

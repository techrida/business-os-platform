// The people a settings card picks from, read under the setting's own permission (R4a Q10).
// GET /v1/admin/settings/crm.default_lead_owner/people answers SettingsPerson[]: the people a new lead may fall back
// to, for anyone who may edit that setting, whether or not they work leads themselves. Only what a picker shows:
// no address, roles or department.
import { z } from 'zod';

export const SettingsPersonSchema = z.object({
  userId: z.guid(),
  displayName: z.string(),
  /** Job title and department, shown muted after the name in the member picker (BOS-UI-001). */
  role: z.string().nullable().optional(),
  /** True on the one person an unset Default lead owner stands for (the Sales head), so the card names them. */
  salesHead: z.boolean().optional(),
});
export type SettingsPerson = z.infer<typeof SettingsPersonSchema>;

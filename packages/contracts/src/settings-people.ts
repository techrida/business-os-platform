// The people a settings card picks from, read under the setting's own permission (R4a Q10).
// GET /v1/admin/settings/crm.default_lead_owner/people answers SettingsPerson[]: the people a new lead may fall back
// to, for anyone who may edit that setting, whether or not they work leads themselves. Only what a picker shows:
// no address, roles or department.
import { z } from 'zod';

export const SettingsPersonSchema = z.object({
  userId: z.guid(),
  displayName: z.string(),
});
export type SettingsPerson = z.infer<typeof SettingsPersonSchema>;

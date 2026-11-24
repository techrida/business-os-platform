// The company's name and logo as a screen or an email may show them (R6Q20). One place decides what of `entity.profile`
// leaves the profile: the display name and the primary logo's document id, nothing else. A profile that does not
// validate (a row edited by hand) gives no name and no logo, so a bad row never breaks a page or an email.
import { type Branding, CompanyProfileSchema } from '@bos/contracts';

import type { TxScope } from '../db/tx';
import type { SettingsService } from './settings.service';

export function brandingFromProfile(tenantId: string, rawProfile: unknown): Branding {
  const profile = CompanyProfileSchema.safeParse(rawProfile);
  if (!profile.success) return { displayName: null, logo: null };
  const { displayName, logoDocumentId } = profile.data;
  return {
    displayName: displayName?.trim() ? displayName.trim() : null,
    logo: logoDocumentId === null ? null : { tenantId, documentId: logoDocumentId },
  };
}

/** The branding of the scope's entity: a plain read of `entity.profile`. */
export async function readBranding(settings: SettingsService, scope: TxScope): Promise<Branding> {
  return brandingFromProfile(scope.tenantId, await settings.get(scope, 'entity.profile'));
}

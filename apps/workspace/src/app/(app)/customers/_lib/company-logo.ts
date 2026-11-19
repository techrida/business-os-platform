// The logo of a customer or vendor company, as the Avatar draws it in lists and headers. Shared by both screens,
// so the same company keeps the same initials colour (seeded from its id) wherever it appears.

/** The fields of a customer or vendor record the logo needs. `logoDocumentId` is optional on both DTOs. */
export interface CompanyLogoRecord {
  id: string;
  legalName: string;
  logoDocumentId?: string | null | undefined;
}

/** The Avatar props for a company: its logo whole on white, or its initials on the colour seeded from its id. */
export function companyLogo(record: CompanyLogoRecord) {
  return {
    name: record.legalName,
    seedId: record.id,
    imageDocumentId: record.logoDocumentId ?? null,
    shape: 'square',
    fit: 'contain',
  } as const;
}

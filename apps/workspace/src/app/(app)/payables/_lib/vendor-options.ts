import type { ComboboxOption } from '@/components/ui/combobox-model';

/** A vendor as the pickers list it: the name, and the tax id the search also matches. */
export function vendorOption(v: {
  id: string;
  legalName: string;
  pan: string | null;
}): ComboboxOption {
  return {
    id: v.id,
    label: v.legalName,
    ...(v.pan !== null && v.pan !== '' ? { description: `PAN ${v.pan}` } : {}),
  };
}

/** How many matches the picker's server search returns. */
export const VENDOR_SEARCH_LIMIT = 20;

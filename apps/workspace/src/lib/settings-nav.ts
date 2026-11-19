/**
 * The Settings menu as data: groups, sections, route, icon, one-line description and the
 * permission that opens each section. Pure data with no React or server import, like nav.ts, so
 * the layout, the index page, the guards and the tests all read the same list.
 *
 * A section is shown only when it is `ready` (its page exists) and the person holds its
 * permission (deny by default). The pages and Server Actions check the permission again; the API
 * is still the authority. Flip `ready` to true in the same change that adds the section's page.
 */
import type { NavIconName } from './nav';

/** Icons the Settings menu can draw. The drawings live in components/ui/icon.tsx. */
export type SettingsIconName =
  NavIconName | 'layout-template' | 'calendar-days' | 'bookmark' | 'hash';

export type SettingsSectionId =
  | 'company'
  | 'documents'
  | 'formats'
  | 'terms'
  | 'users'
  | 'roles'
  | 'workflows'
  | 'currencies'
  | 'tax'
  | 'numbering'
  | 'sales'
  | 'purchasing';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  href: string;
  icon: SettingsIconName;
  /** One line under the name on the index and the phone menu. */
  description: string;
  /** The permission, or any one of a list, that opens the section. */
  permission: string | readonly string[];
  /** False until the section's page exists: the menu never links to a missing page. */
  ready: boolean;
}

export interface SettingsGroup {
  label: string;
  sections: readonly SettingsSection[];
}

// The four Company sections are built in parallel with this shell. They use `admin.settings.write`
// for now; plan section 4 splits them into admin.settings.{company,documents,formats,terms}.write
// once those permissions exist in the contracts.
const COMPANY_PERMISSION = 'admin.settings.write';

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: 'Company',
    sections: [
      {
        id: 'company',
        label: 'Company profile',
        href: '/settings/company',
        icon: 'building',
        description: 'Name, address, contact details and logo printed on documents.',
        permission: COMPANY_PERMISSION,
        ready: false,
      },
      {
        id: 'documents',
        label: 'Document templates',
        href: '/settings/documents',
        icon: 'layout-template',
        description: 'Layout and colour of the quotations you send.',
        permission: COMPANY_PERMISSION,
        ready: false,
      },
      {
        id: 'formats',
        label: 'Number and date format',
        href: '/settings/formats',
        icon: 'calendar-days',
        description: 'How amounts are grouped and how dates are written.',
        permission: COMPANY_PERMISSION,
        ready: false,
      },
      {
        id: 'terms',
        label: 'Saved terms',
        href: '/settings/terms',
        icon: 'bookmark',
        description: 'Ready-made wording for scope, delivery and payment terms.',
        permission: COMPANY_PERMISSION,
        ready: false,
      },
    ],
  },
  {
    label: 'People and access',
    sections: [
      {
        id: 'users',
        label: 'Users',
        href: '/settings/users',
        icon: 'users',
        description: 'See who has access, invite a colleague and change their roles.',
        permission: ['admin.users.read', 'admin.users.invite'],
        ready: true,
      },
      {
        id: 'roles',
        label: 'Roles and permissions',
        href: '/settings/roles',
        icon: 'shield-check',
        description: 'What each role may do, and how far each permission reaches.',
        permission: ['admin.roles.read', 'admin.roles.write'],
        ready: true,
      },
      {
        id: 'workflows',
        label: 'Approval workflows',
        href: '/settings/workflows',
        icon: 'git-branch',
        description: 'Approval routes and thresholds, approval groups and delegations.',
        permission: [
          'approvals.definitions.read',
          'approvals.definitions.write',
          'approvals.groups.write',
          'approvals.delegations.write',
        ],
        ready: true,
      },
    ],
  },
  {
    label: 'Finance',
    sections: [
      {
        id: 'currencies',
        label: 'Currencies and exchange rates',
        href: '/settings/currencies',
        icon: 'repeat',
        description: 'Which currencies documents may use, and the NPR rate for each.',
        permission: 'admin.settings.write',
        ready: true,
      },
      {
        id: 'tax',
        label: 'Tax',
        href: '/settings/tax',
        icon: 'receipt',
        description: 'VAT and withholding codes, and the default VAT rate.',
        permission: 'admin.settings.write',
        ready: true,
      },
      {
        id: 'numbering',
        label: 'Document numbering',
        href: '/settings/numbering',
        icon: 'hash',
        description: 'The numbers quotations, invoices and memos are given.',
        permission: 'admin.settings.write',
        ready: true,
      },
    ],
  },
  {
    label: 'Sales and purchasing',
    sections: [
      {
        id: 'sales',
        label: 'Sales',
        href: '/settings/sales',
        icon: 'trending-up',
        description: 'Quotation validity, evidence for won deals and the billing schedule.',
        permission: 'admin.settings.write',
        ready: true,
      },
      {
        id: 'purchasing',
        label: 'Purchasing',
        href: '/settings/purchasing',
        icon: 'briefcase',
        description: 'Quotes needed, bill matching tolerance and approval bands.',
        permission: 'admin.settings.write',
        ready: true,
      },
    ],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap(
  (group) => group.sections,
);

const asList = (permission: string | readonly string[]): readonly string[] =>
  typeof permission === 'string' ? [permission] : permission;

/** True when `can` grants the section's permission, or any one of them. No predicate grants none. */
export function canOpenSection(
  section: SettingsSection,
  can: ((permission: string) => boolean) | undefined,
): boolean {
  return asList(section.permission).some((permission) => can?.(permission) === true);
}

/** Ready sections the person may open, grouped; a group with none left is omitted. */
export function visibleSettingsGroups(
  can: ((permission: string) => boolean) | undefined,
): readonly SettingsGroup[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((section) => section.ready && canOpenSection(section, can)),
  })).filter((group) => group.sections.length > 0);
}

/** The section with this id. */
export function settingsSection(id: SettingsSectionId): SettingsSection {
  const found = SETTINGS_SECTIONS.find((section) => section.id === id);
  if (found === undefined) throw new Error(`Unknown settings section: ${id}`);
  return found;
}

/** The first section the person may open: where a refused visitor is sent. Undefined when none. */
export function firstAllowedSection(
  can: ((permission: string) => boolean) | undefined,
): SettingsSection | undefined {
  return visibleSettingsGroups(can)[0]?.sections[0];
}

/** The section that owns a path (`/settings/users/new` belongs to Users), if any. */
export function sectionForPath(pathname: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find(
    (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
  );
}

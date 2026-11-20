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
  NavIconName | 'layout-template' | 'calendar-days' | 'bookmark' | 'hash' | 'mail';

export type SettingsSectionId =
  | 'company'
  | 'documents'
  | 'formats'
  | 'terms'
  | 'users'
  | 'departments'
  // The Access section keeps the id 'roles' so existing guards keep working; it is labelled Access.
  | 'roles'
  | 'workflows'
  | 'email-delivery'
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

export type SettingsGroupId = 'company-setup' | 'organisation' | 'finance' | 'sales-and-purchasing';

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  /** Addressable section index URL; redirects to the first sub-tab the person may open. */
  href: string;
  icon: SettingsIconName;
  /** One line under the section name on the index and the phone menu. */
  description: string;
  /** Sub-tabs within this left-hand section. */
  sections: readonly SettingsSection[];
}

// Company profile, document templates and formats stay with `admin.settings.write` (the Founder).
const COMPANY_PERMISSION = 'admin.settings.write';
// Exchange rates are entered by Finance (`settings.fx_rate.write`). The Founder keeps the page too,
// and alone changes which currencies are enabled and how old a rate may be (F1-Q48).
const FX_RATE_PERMISSION = ['settings.fx_rate.write', 'admin.settings.write'] as const;
// Tax, document numbering and saved terms: Finance or Accountant (`settings.finance.write`), or the
// Founder (F1-Q48).
const FINANCE_SETTINGS_PERMISSION = ['settings.finance.write', 'admin.settings.write'] as const;

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'company-setup',
    label: 'Company',
    href: '/settings/company-setup',
    icon: 'building',
    description: 'Company profile, document templates, number and date format, and saved terms.',
    sections: [
      {
        id: 'company',
        label: 'Company profile',
        href: '/settings/company',
        icon: 'building',
        description: 'Name, address, contact details and logo printed on documents.',
        permission: COMPANY_PERMISSION,
        ready: true,
      },
      {
        id: 'documents',
        label: 'Document templates',
        href: '/settings/documents',
        icon: 'layout-template',
        description: 'Layout and colour of the quotations you send.',
        permission: COMPANY_PERMISSION,
        ready: true,
      },
      {
        id: 'formats',
        label: 'Number and date format',
        href: '/settings/formats',
        icon: 'calendar-days',
        description: 'How amounts are grouped and how dates are written.',
        permission: COMPANY_PERMISSION,
        ready: true,
      },
      {
        id: 'terms',
        label: 'Saved terms',
        href: '/settings/terms',
        icon: 'bookmark',
        description: 'Ready-made wording for scope, delivery and payment terms.',
        permission: FINANCE_SETTINGS_PERMISSION,
        ready: true,
      },
    ],
  },
  {
    id: 'organisation',
    label: 'Organisation',
    href: '/settings/organisation',
    icon: 'users',
    description: 'Users, departments, access controls and approval workflows.',
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
        id: 'departments',
        label: 'Departments',
        href: '/settings/departments',
        icon: 'layers',
        description: 'Who works in each department, their level and the department head.',
        permission: ['admin.users.read', 'admin.roles.read'],
        ready: true,
      },
      {
        id: 'roles',
        label: 'Access',
        href: '/settings/access',
        icon: 'shield-check',
        description: 'Who can see and do what, and who can hand work to whom.',
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
          'approvals.definitions.publish',
          'approvals.groups.write',
          'approvals.delegations.write',
        ],
        ready: true,
      },
      {
        id: 'email-delivery',
        label: 'Email delivery',
        href: '/settings/email-delivery',
        icon: 'mail',
        description: 'Emails that could not be delivered, and sending them again.',
        permission: ['email_delivery.read'],
        ready: true,
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    href: '/settings/finance',
    icon: 'banknote',
    description: 'Currencies, exchange rates, tax codes and document numbering.',
    sections: [
      {
        id: 'currencies',
        label: 'Currencies and exchange rates',
        href: '/settings/currencies',
        icon: 'repeat',
        description: 'Which currencies documents may use, and the NPR rate for each.',
        permission: FX_RATE_PERMISSION,
        ready: true,
      },
      {
        id: 'tax',
        label: 'Tax',
        href: '/settings/tax',
        icon: 'receipt',
        description: 'VAT and withholding codes documents can use.',
        permission: FINANCE_SETTINGS_PERMISSION,
        ready: true,
      },
      {
        id: 'numbering',
        label: 'Document numbering',
        href: '/settings/numbering',
        icon: 'hash',
        description: 'The numbers quotations, invoices and memos are given.',
        permission: FINANCE_SETTINGS_PERMISSION,
        ready: true,
      },
    ],
  },
  {
    id: 'sales-and-purchasing',
    label: 'Sales and purchasing',
    href: '/settings/sales-and-purchasing',
    icon: 'trending-up',
    description: 'Quotation, deal, billing schedule and purchasing defaults.',
    sections: [
      {
        id: 'sales',
        label: 'Sales',
        href: '/settings/sales',
        icon: 'trending-up',
        description:
          'Quotation validity, evidence for won deals, the billing schedule and delivery holds.',
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

const matchesHref = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

/** True when `can` grants the section's permission, or any one of them. No predicate grants none. */
export function canOpenSection(
  section: SettingsSection,
  can: ((permission: string) => boolean) | undefined,
): boolean {
  return asList(section.permission).some((permission) => can?.(permission) === true);
}

/** Ready sub-tabs the person may open, grouped into sections; a section with none left is omitted. */
export function visibleSettingsGroups(
  can: ((permission: string) => boolean) | undefined,
): readonly SettingsGroup[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((section) => section.ready && canOpenSection(section, can)),
  })).filter((group) => group.sections.length > 0);
}

/** The sub-tab with this id. */
export function settingsSection(id: SettingsSectionId): SettingsSection {
  const found = SETTINGS_SECTIONS.find((section) => section.id === id);
  if (found === undefined) throw new Error(`Unknown settings section: ${id}`);
  return found;
}

/** The top-level section with this id. */
export function settingsGroup(id: SettingsGroupId): SettingsGroup {
  const found = SETTINGS_GROUPS.find((group) => group.id === id);
  if (found === undefined) throw new Error(`Unknown settings group: ${id}`);
  return found;
}

/** The first sub-tab the person may open: where a refused visitor is sent. Undefined when none. */
export function firstAllowedSection(
  can: ((permission: string) => boolean) | undefined,
): SettingsSection | undefined {
  return visibleSettingsGroups(can)[0]?.sections[0];
}

/** The first sub-tab inside `id` that the person may open, or undefined when none opens. */
export function firstAllowedInGroup(
  id: SettingsGroupId,
  can: ((permission: string) => boolean) | undefined,
): SettingsSection | undefined {
  return visibleSettingsGroups(can).find((group) => group.id === id)?.sections[0];
}

/** The sub-tab that owns a path (`/settings/users/new` belongs to Users), if any. */
export function sectionForPath(
  pathname: string,
  sections: readonly SettingsSection[] = SETTINGS_SECTIONS,
): SettingsSection | undefined {
  return sections.find((section) => matchesHref(pathname, section.href));
}

/** The top-level section that owns a path (its index URL or any sub-tab under it), if any. */
export function groupForPath(
  pathname: string,
  groups: readonly SettingsGroup[] = SETTINGS_GROUPS,
): SettingsGroup | undefined {
  return groups.find(
    (group) =>
      matchesHref(pathname, group.href) ||
      group.sections.some((section) => matchesHref(pathname, section.href)),
  );
}

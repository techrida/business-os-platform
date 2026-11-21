// Pure display rules for the Overview page. No server-only import, so tests and the page share them.
import { type ActivityDto, type LeadStage, OPPORTUNITY_STAGES } from '@bos/contracts';

import type { IconName } from '@/components/ui/icon';

import { documentTypeWords, DRAFT_REFERENCE_SOURCE } from './kernel-format';

const KATHMANDU = 'Asia/Kathmandu';

/** The first word of a person's name, or null when there is no name worth greeting (blank, or an email). */
export function firstName(name: string | undefined | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.includes('@')) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/** `Good morning, Amanda` by the hour in Kathmandu; `Welcome back` when no name is known. */
export function greetingFor(now: Date, name: string | undefined | null): string {
  const first = firstName(name);
  if (first === null) return 'Welcome back';
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: KATHMANDU,
    }).format(now),
  );
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `Good ${part}, ${first}`;
}

const DRAFT_REFERENCE = new RegExp(String.raw`\b${DRAFT_REFERENCE_SOURCE}\b`, 'g');
const UUID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;

/**
 * Notification text for display only. The approvals producer names a document that has no number
 * yet `Draft <document type> <first 8 characters of its id>`; that reads as `Tax invoice draft`.
 * Whole ids are dropped. The stored notification is not changed.
 */
export function notificationText(raw: string): string {
  return raw
    .replace(DRAFT_REFERENCE, (_match, type: string, offset: number) => {
      const phrase = `${documentTypeWords(type)} draft`;
      return offset === 0 ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1);
    })
    .replace(UUID, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

/** Lead stages that count as open: not converted, lost or on hold. */
const OPEN_LEAD_STAGES = ['new', 'contacted', 'qualified'] as const satisfies readonly LeadStage[];

export function openLeadCount(byStage: Readonly<Record<string, number>>): number {
  return OPEN_LEAD_STAGES.reduce((sum, stage) => sum + (byStage[stage] ?? 0), 0);
}

/** The opportunities page's "Active pipeline": every stage but won, lost and on hold. */
export const ACTIVE_OPPORTUNITY_STAGES = OPPORTUNITY_STAGES.filter(
  (stage) => stage !== 'won' && stage !== 'lost' && stage !== 'on_hold',
);

export interface QuickAction {
  key: string;
  label: string;
  href: string;
  icon: IconName;
}

/**
 * The shortcut tiles the caller may use. A tile for something the caller cannot do is not built.
 * There is no Opportunity tile: an opportunity is created by converting a lead, so it has no form.
 */
export function quickActions(can: (permission: string) => boolean): QuickAction[] {
  const tiles: [allowed: boolean, tile: QuickAction][] = [
    [can('crm.lead.write'), { key: 'lead', label: 'New lead', href: '/leads/new', icon: 'target' }],
    [
      can('customer.write'),
      { key: 'customer', label: 'New customer', href: '/customers/new', icon: 'building' },
    ],
    [
      can('quotation.draft'),
      { key: 'quotation', label: 'Quotation', href: '/opportunities', icon: 'file-text' },
    ],
    [
      can('memo.read') || can('memo.create'),
      { key: 'memos', label: 'Memos', href: '/memos', icon: 'file-text' },
    ],
    [
      can('admin.users.invite'),
      { key: 'user', label: 'Add user', href: '/settings/users/new', icon: 'users' },
    ],
  ];
  return tiles.filter(([allowed]) => allowed).map(([, tile]) => tile);
}

const DID: Partial<Record<ActivityDto['kind'], string>> = {
  call: 'logged a call',
  meeting: 'logged a meeting',
  email: 'logged an email',
  note: 'added a note',
  collection_call: 'completed a collection call',
};
const HAPPENED: Record<string, string> = {
  call: 'Call logged',
  meeting: 'Meeting logged',
  email: 'Email logged',
  note: 'Note added',
  collection_call: 'Collection call completed',
  task: 'Task',
  stage_change: 'Stage changed',
  system: 'System update',
};

/** `Amanda Vance logged a call`; without a resolved name or a verb, `Call logged`. Never an id. */
export function activityHeadline(kind: string, actorName: string | undefined): string {
  const did = DID[kind as ActivityDto['kind']];
  const who = actorName?.trim();
  if (who && did) return `${who} ${did}`;
  return HAPPENED[kind] ?? 'Activity';
}

/** The record an activity belongs to, as an existing detail page; null when it has none. */
export function activityHref(
  a: Pick<ActivityDto, 'leadId' | 'opportunityId' | 'customerId' | 'quotationId'>,
): string | null {
  if (a.quotationId) return `/quotations/${encodeURIComponent(a.quotationId)}`;
  if (a.opportunityId) return `/opportunities/${encodeURIComponent(a.opportunityId)}`;
  if (a.leadId) return `/leads/${encodeURIComponent(a.leadId)}`;
  if (a.customerId) return `/customers/${encodeURIComponent(a.customerId)}`;
  return null;
}

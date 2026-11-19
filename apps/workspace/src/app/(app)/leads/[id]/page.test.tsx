// @vitest-environment jsdom
import type { ActivityDto, LeadDto, LeadOwnerOption } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import LeadPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getLead: vi.fn(),
  listActivities: vi.fn(),
  listLeadOwners: vi.fn(),
  moveForm: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getLead: mocks.getLead,
  listActivities: mocks.listActivities,
  listLeadOwners: mocks.listLeadOwners,
}));
// The Move-to options live in a closed listbox, so the stub records what the page asks it to offer.
vi.mock('@/components/p2/crm/move-form', () => ({
  MoveForm: (props: unknown) => {
    mocks.moveForm(props);
    return null;
  },
  toastMoveResult: vi.fn(),
}));
vi.mock('../../activities/actions', () => ({ logActivityAction: vi.fn() }));
vi.mock('../actions', () => ({
  moveLeadStageAction: vi.fn(),
  createLeadAction: vi.fn(),
  convertLeadAction: vi.fn(),
  scheduleFollowUpAction: vi.fn(),
  completeFollowUpAction: vi.fn(),
  rescheduleFollowUpAction: vi.fn(),
  cancelFollowUpAction: vi.fn(),
  updateLeadOwnerAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const LEAD = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '22222222-2222-4222-8222-222222222223';
const WHEN = '2026-11-08T05:45:00.000Z';

const lead = (over: Partial<LeadDto> = {}): LeadDto => ({
  id: LEAD,
  number: 'LD-2026-0019',
  title: 'Inventory and dispatch automation',
  source: 'website',
  campaign: null,
  ownerUserId: OWNER,
  companyName: 'Himalayan Agro Foods Pvt. Ltd.',
  contactName: 'Sunita Shrestha',
  email: null,
  phone: null,
  customerId: null,
  contactId: null,
  requirement: null,
  expectedValue: null,
  currency: 'NPR',
  probability: null,
  expectedClose: null,
  nextFollowUpAt: null,
  stage: 'new',
  stageReason: null,
  stageNote: null,
  convertedOpportunityId: null,
  version: 3,
  createdAt: WHEN,
  updatedAt: WHEN,
  ...over,
});

const activity = (id: string, over: Partial<ActivityDto>): ActivityDto => ({
  id,
  kind: 'call',
  subject: 'Call',
  body: null,
  leadId: LEAD,
  opportunityId: null,
  customerId: null,
  contactId: null,
  quotationId: null,
  dueAt: null,
  assigneeUserId: null,
  completedAt: null,
  cancelledAt: null,
  planned: false,
  createdByUserId: null,
  occurredAt: WHEN,
  version: 1,
  ...over,
});

const PLANNED = activity('33333333-3333-4333-8333-333333333331', {
  subject: 'Book requirement workshop',
  dueAt: '2026-11-30T05:00:00.000Z',
  assigneeUserId: OWNER,
  planned: true,
});
const LOGGED = activity('33333333-3333-4333-8333-333333333332', {
  subject: 'Intro call with Sunita',
  createdByUserId: OWNER,
});
const STAGE_CHANGE = activity('33333333-3333-4333-8333-333333333333', {
  kind: 'stage_change',
  subject: 'Moved from new to contacted',
  occurredAt: '2026-11-09T05:45:00.000Z',
});

const OWNERS: LeadOwnerOption[] = [
  { userId: OWNER, displayName: 'Anil Karki', email: 'anil@example.test' },
  { userId: OTHER, displayName: 'Mira Thapa', email: 'mira@example.test' },
];

async function render(): Promise<Document> {
  const html = renderToStaticMarkup(await LeadPage({ params: Promise.resolve({ id: LEAD }) }));
  return new DOMParser().parseFromString(html, 'text/html');
}

/** The card (section or aside) whose heading reads `title`. */
function card(doc: Document, title: string): Element {
  // A card heading may carry a decorative eyebrow before its title.
  const heading = [...doc.querySelectorAll('h2')].find((h) =>
    h.textContent?.trim().endsWith(title),
  );
  const found = heading?.closest('section, aside');
  if (!found) throw new Error(`No card titled ${title}`);
  return found;
}

/** The page header's action buttons, by label. */
function headerButtons(doc: Document): string[] {
  // PageHeader: h1 > title row > head text > header (whose last child holds the actions).
  const header = doc.querySelector('h1')?.parentElement?.parentElement?.parentElement;
  return [...(header?.querySelectorAll('button, a') ?? [])].map((b) => b.textContent?.trim() ?? '');
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.getLead.mockReset().mockResolvedValue(lead());
  mocks.listActivities
    .mockReset()
    .mockImplementation((_session: unknown, opts: { status?: string }) =>
      Promise.resolve(
        opts.status === 'planned'
          ? [PLANNED]
          : opts.status === 'logged'
            ? [LOGGED, STAGE_CHANGE]
            : [],
      ),
    );
  mocks.listLeadOwners.mockReset().mockResolvedValue(OWNERS);
  mocks.moveForm.mockReset();
});

describe('lead detail page composition (U14 D39, D41)', () => {
  it('asks for planned and logged activities separately', async () => {
    await render();
    expect(mocks.listActivities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: LEAD, status: 'planned' }),
    );
    expect(mocks.listActivities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: LEAD, status: 'logged' }),
    );
  });

  it('shows planned follow-ups only on the Follow-ups card and logged rows only in History', async () => {
    const doc = await render();
    const followUps = card(doc, 'Follow-ups').textContent ?? '';
    const history = card(doc, 'History').textContent ?? '';
    expect(followUps).toContain('Book requirement workshop');
    expect(followUps).not.toContain('Intro call with Sunita');
    expect(history).toContain('Intro call with Sunita');
    expect(history).not.toContain('Book requirement workshop');
    // History names the actor through the owners list.
    expect(history).toContain('Anil Karki');
  });

  it('offers Schedule follow-up on the Follow-ups card', async () => {
    const doc = await render();
    const buttons = [...card(doc, 'Follow-ups').querySelectorAll('button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(buttons).toContain('Schedule follow-up');
  });

  it('still renders, read-only and without names, when the owners list fails', async () => {
    mocks.listLeadOwners.mockRejectedValue(new ApiError(403, 'Forbidden'));
    const doc = await render();
    expect(doc.querySelector('h1')?.textContent).toBe('Inventory and dispatch automation');
    expect(card(doc, 'Follow-ups').textContent).toContain('Book requirement workshop');
    expect(card(doc, 'History').textContent).toContain('Intro call with Sunita');
    expect(card(doc, 'Lead overview').textContent).toContain('Lead owner');
    expect(doc.body.textContent).not.toContain('Save owner');
  });

  it('shows the error Alert, not an empty card, when the follow-ups fail to load', async () => {
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      opts.status === 'planned'
        ? Promise.reject(new ApiError(500, 'Server error'))
        : Promise.resolve([LOGGED]),
    );
    const doc = await render();
    const followUps = card(doc, 'Follow-ups');
    expect(followUps.textContent).toContain('Follow-ups did not load');
    expect(followUps.textContent).not.toContain('No follow-ups planned');
    expect(card(doc, 'History').textContent).toContain('Intro call with Sunita');
  });

  it('shows the History Alert when logged activities fail to load', async () => {
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      opts.status === 'logged'
        ? Promise.reject(new ApiError(500, 'Server error'))
        : Promise.resolve([PLANNED]),
    );
    const doc = await render();
    expect(card(doc, 'History').textContent).toContain('Activity did not load');
    expect(card(doc, 'Follow-ups').textContent).toContain('Book requirement workshop');
  });

  it.each([
    // The stage rules have no user move from New straight to Qualified, so New offers Mark lost only.
    ['new', ['Mark lost']],
    ['contacted', ['Qualify', 'Mark lost']],
    ['lost', []],
    ['converted', []],
  ] as const)('header actions for a %s lead: %j', async (stage, expected) => {
    mocks.getLead.mockResolvedValue(
      lead({
        stage,
        ...(stage === 'lost' ? { stageReason: 'Budget', stageNote: 'No budget this year.' } : {}),
        ...(stage === 'converted'
          ? { convertedOpportunityId: '44444444-4444-4444-8444-444444444444' }
          : {}),
      }),
    );
    const doc = await render();
    expect(headerButtons(doc)).toEqual(expected);
    // Without actions the header draws no empty actions slot: head text is its only child.
    const header = doc.querySelector('h1')?.parentElement?.parentElement?.parentElement;
    expect(header?.children.length).toBe(expected.length ? 2 : 1);
  });

  it('has no Log activity header button or link; the form sits in the main column', async () => {
    const doc = await render();
    expect(headerButtons(doc)).not.toContain('Log activity');
    expect(doc.getElementById('lead-activity-form')).toBeNull();
    expect(doc.querySelector('a[href="#lead-activity-form"]')).toBeNull();
    const logPanel = card(doc, 'Log activity');
    const history = card(doc, 'History');
    // Same column as History, after it.
    expect(logPanel.parentElement).toBe(history.parentElement);
    expect(
      history.compareDocumentPosition(logPanel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('leaves Qualify, Lost and Converted out of the Move-to panel', async () => {
    await render();
    expect(mocks.moveForm).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: ['qualified', 'lost', 'converted'] }),
    );
  });

  it('reads stage-change dates for the progression from the logged list', async () => {
    const doc = await render();
    const timeline = doc.querySelector('[aria-label="Lead progression"]');
    expect(timeline?.textContent).toContain('Contacted');
    expect(timeline?.textContent).not.toMatch(/Contacted\s*Not yet/);
  });
});

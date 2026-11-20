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
  listLeadLostReasonChoices: vi.fn(),
  userNames: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-lead-lost-reasons', () => ({
  listLeadLostReasonChoices: mocks.listLeadLostReasonChoices,
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getLead: mocks.getLead,
  listActivities: mocks.listActivities,
  listLeadOwners: mocks.listLeadOwners,
}));
vi.mock('@/lib/business-labels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userNames: mocks.userNames,
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
const LOST_REASON = '7b0e6c1a-2f4d-4c55-8a39-6d1f5e2c9b10';

const lead = (over: Partial<LeadDto> = {}): LeadDto => ({
  id: LEAD,
  number: 'LD-2026-0019',
  title: 'Inventory and dispatch automation',
  source: 'website',
  campaign: null,
  ownerUserId: OWNER,
  ownerName: 'Anil Karki',
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
  lostReason: null,
  stageNote: null,
  convertedOpportunityId: null,
  allowedMoves: ['contacted', 'on_hold', 'lost'],
  canEdit: true,
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
  assigneeName: null,
  completedAt: null,
  cancelledAt: null,
  planned: false,
  createdByUserId: null,
  createdByName: null,
  occurredAt: WHEN,
  version: 1,
  ...over,
});

const PLANNED = activity('33333333-3333-4333-8333-333333333331', {
  subject: 'Book requirement workshop',
  dueAt: '2026-11-30T05:00:00.000Z',
  assigneeUserId: OWNER,
  assigneeName: 'Anil Karki',
  planned: true,
});
const LOGGED = activity('33333333-3333-4333-8333-333333333332', {
  subject: 'Intro call with Sunita',
  createdByUserId: OWNER,
  createdByName: 'Anil Karki',
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
  const heading = [...doc.querySelectorAll('h2')].find((h) =>
    h.textContent?.trim().endsWith(title),
  );
  const found = heading?.closest('section, aside');
  if (!found) throw new Error(`No card titled ${title}`);
  return found;
}

/** The page header's action buttons, by label. */
function headerButtons(doc: Document): string[] {
  const header = doc.querySelector('h1')?.parentElement?.parentElement?.parentElement;
  if (!header) throw new Error('PageHeader container not found');
  return [...header.querySelectorAll('button, a')].map((b) => b.textContent?.trim() ?? '');
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
  mocks.userNames.mockReset().mockResolvedValue(new Map());
  mocks.listLeadLostReasonChoices.mockReset().mockResolvedValue([]);
});

describe('lead detail page composition (U14 D39, D41, D48)', () => {
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

  it('renders no Move to dropdown or stage select anywhere on the page', async () => {
    const doc = await render();
    expect(doc.body.textContent).not.toContain('Move to');
    expect(doc.querySelector('select[name="stage"]')).toBeNull();
    expect(doc.querySelector('input[name="stage"]')).toBeNull();
  });

  it('shows planned follow-ups only on the Follow-ups card and logged rows only in History', async () => {
    const doc = await render();
    const followUps = card(doc, 'Follow-ups').textContent ?? '';
    const history = card(doc, 'History').textContent ?? '';
    expect(followUps).toContain('Book requirement workshop');
    expect(followUps).not.toContain('Intro call with Sunita');
    expect(history).toContain('Intro call with Sunita');
    expect(history).not.toContain('Book requirement workshop');
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
    [
      'new',
      ['contacted', 'on_hold', 'lost'] as LeadDto['stage'][],
      ['Mark contacted', 'Put on hold', 'Mark lost'],
      'Log a call or email with Mark contacted to move this lead to Contacted.',
    ],
    [
      'contacted',
      ['qualified', 'on_hold', 'lost'] as LeadDto['stage'][],
      ['Qualify', 'Put on hold', 'Mark lost'],
      'Use the header actions to qualify this lead, put it on hold, or mark it lost.',
    ],
    [
      'qualified',
      ['on_hold', 'lost'] as LeadDto['stage'][],
      ['Put on hold', 'Mark lost'],
      'Qualifying is complete. Convert this lead to an opportunity, put it on hold, or mark it lost.',
    ],
    [
      'on_hold',
      ['contacted'] as LeadDto['stage'][],
      ['Resume'],
      'This lead is on hold. Use Resume in the header to move it back to Contacted.',
    ],
    // F1-Q53: a lead held at Qualified resumes to Qualified, the one move the server sends.
    [
      'on_hold',
      ['qualified'] as LeadDto['stage'][],
      ['Resume'],
      'This lead is on hold. Use Resume in the header to move it back to Qualified.',
    ],
    [
      'on_hold',
      ['new'] as LeadDto['stage'][],
      ['Resume'],
      'This lead is on hold. Use Resume in the header to move it back to New.',
    ],
    ['on_hold', [] as LeadDto['stage'][], [], 'This lead is on hold.'],
    ['lost', [] as LeadDto['stage'][], [], 'Only a manager can reopen a lost lead.'],
    [
      'lost',
      ['contacted'] as LeadDto['stage'][],
      ['Reopen'],
      'This lead is lost. Use Reopen in the header to return it to Contacted.',
    ],
    ['converted', [] as LeadDto['stage'][], [], 'This lead is converted. Its stage is final.'],
  ])(
    'header actions and Stage panel text for %s with allowedMoves %j',
    async (stage, allowedMoves, expectedButtons, expectedStageText) => {
      mocks.getLead.mockResolvedValue(
        lead({
          stage: stage as LeadDto['stage'],
          allowedMoves,
          ...(stage === 'lost'
            ? {
                stageReason: 'No budget',
                lostReason: { id: LOST_REASON, label: 'No budget', retired: false },
                stageNote: 'No budget this year.',
              }
            : {}),
          ...(stage === 'on_hold'
            ? {
                stageReason: 'Waiting on Q2 budget',
                stageNote: 'Check back in April.',
                heldFromStage: allowedMoves[0] ?? null,
              }
            : {}),
          ...(stage === 'converted'
            ? { convertedOpportunityId: '44444444-4444-4444-8444-444444444444' }
            : {}),
        }),
      );
      const doc = await render();
      expect(headerButtons(doc)).toEqual(expectedButtons);
      // Without actions the header draws no empty actions slot: head text is its only child.
      const header = doc.querySelector('h1')?.parentElement?.parentElement?.parentElement;
      expect(header?.children.length).toBe(expectedButtons.length ? 2 : 1);
      expect(card(doc, 'Stage').textContent).toContain(expectedStageText);
    },
  );

  it('shows On Hold in the timeline with its stage-change date, reason and note', async () => {
    const holdChange = activity('33333333-3333-4333-8333-333333333334', {
      kind: 'stage_change',
      subject: 'Moved from contacted to on_hold',
      occurredAt: '2026-11-12T05:45:00.000Z',
    });
    mocks.getLead.mockResolvedValue(
      lead({
        stage: 'on_hold',
        allowedMoves: ['contacted'],
        stageReason: 'Waiting on Q2 budget',
        stageNote: 'Re-engage after fiscal close.',
      }),
    );
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(opts.status === 'logged' ? [holdChange, STAGE_CHANGE, LOGGED] : []),
    );

    const doc = await render();
    const timeline = doc.querySelector('[aria-label="Lead progression"]');
    const timelineCard = timeline?.parentElement;
    expect(timeline?.textContent).toContain('On Hold');
    expect(timeline?.textContent).not.toMatch(/On Hold\s*Current/);
    expect(timelineCard?.textContent).toContain('Waiting on Q2 budget');
    expect(timelineCard?.textContent).toContain('Re-engage after fiscal close.');
  });

  it('enforces read-only mode when canEdit is false and allowedMoves is empty', async () => {
    mocks.getLead.mockResolvedValue(
      lead({
        stage: 'qualified',
        allowedMoves: [],
        canEdit: false,
      }),
    );

    const doc = await render();
    expect(headerButtons(doc)).toEqual([]);
    expect(mocks.listLeadLostReasonChoices).not.toHaveBeenCalled();
    expect(card(doc, 'Stage').textContent).toContain('You have read-only access to this lead.');
    expect(card(doc, 'Convert to opportunity').textContent).toContain(
      'You have read-only access to this lead.',
    );
    expect(card(doc, 'Convert to opportunity').querySelector('button')).toBeNull();
    expect(card(doc, 'Log activity').textContent).toContain(
      'You have read-only access to this lead.',
    );
    expect(card(doc, 'Log activity').querySelector('form')).toBeNull();
    expect(card(doc, 'Lead overview').textContent).not.toContain('Save owner');
    const followUps = card(doc, 'Follow-ups');
    expect(followUps.textContent).not.toContain('Schedule follow-up');
    expect(followUps.querySelectorAll('button')).toHaveLength(0);
  });

  it('hides the owner editor on a converted lead and picks the latest stage_change date', async () => {
    const olderContacted = activity('33333333-3333-4333-8333-333333333335', {
      kind: 'stage_change',
      subject: 'Moved from new to contacted',
      occurredAt: '2026-11-09T05:45:00.000Z',
    });
    const newerContacted = activity('33333333-3333-4333-8333-333333333336', {
      kind: 'stage_change',
      subject: 'Moved from on_hold to contacted',
      occurredAt: '2026-11-18T05:45:00.000Z',
    });
    mocks.getLead.mockResolvedValue(
      lead({
        stage: 'converted',
        allowedMoves: [],
        convertedOpportunityId: '44444444-4444-4444-8444-444444444444',
      }),
    );
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(opts.status === 'logged' ? [olderContacted, newerContacted] : []),
    );
    const doc = await render();
    expect(card(doc, 'Lead overview').textContent).not.toContain('Save owner');
    const timelineText = doc.querySelector('[aria-label="Lead progression"]')?.textContent ?? '';
    expect(timelineText).toContain('18 Nov 2026');
    expect(timelineText).not.toContain('09 Nov 2026');
  });

  it('fails closed when canEdit and allowedMoves are omitted for a read-only role', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['management'] });
    mocks.getLead.mockResolvedValue(
      lead({ stage: 'contacted', canEdit: undefined, allowedMoves: undefined }),
    );
    const doc = await render();
    expect(headerButtons(doc)).toEqual([]);
    expect(card(doc, 'Stage').textContent).toContain('You have read-only access to this lead.');
    expect(card(doc, 'Follow-ups').querySelectorAll('button')).toHaveLength(0);
  });

  it('reads the lost reasons only when Mark lost is offered, and shows the reason by its option label (D49)', async () => {
    mocks.listLeadLostReasonChoices.mockResolvedValue([
      {
        id: LOST_REASON,
        label: 'No budget',
        position: 2,
        isDefault: true,
        retired: false,
        version: 1,
      },
    ]);
    await render();
    expect(mocks.listLeadLostReasonChoices).toHaveBeenCalledOnce();

    mocks.listLeadLostReasonChoices.mockClear();
    mocks.getLead.mockResolvedValue(
      lead({
        stage: 'lost',
        allowedMoves: [],
        stageReason: 'Timing',
        lostReason: { id: LOST_REASON, label: 'Bad timing', retired: true },
        stageNote: 'Next year.',
      }),
    );
    const doc = await render();
    expect(mocks.listLeadLostReasonChoices).not.toHaveBeenCalled();
    const text = doc.body.textContent ?? '';
    expect(text).toContain('Bad timing');
    expect(text).toContain('This reason is no longer offered for new leads.');
    expect(text).toContain('Next year.');
  });

  it('still shows the saved words for a lead lost before the list existed', async () => {
    mocks.getLead.mockResolvedValue(
      lead({
        stage: 'lost',
        allowedMoves: [],
        stageReason: 'Budget',
        lostReason: null,
        stageNote: 'Gone quiet.',
      }),
    );
    const text = (await render()).body.textContent ?? '';
    expect(text).toContain('Budget');
    expect(text).not.toContain('no longer offered');
  });

  it('opens the page without the reasons when the list cannot be read', async () => {
    mocks.listLeadLostReasonChoices.mockRejectedValue(new Error('down'));
    const doc = await render();
    expect(headerButtons(doc)).toContain('Mark lost');
  });

  it('has no Log activity header button or link; the form sits in the main column', async () => {
    const doc = await render();
    expect(headerButtons(doc)).not.toContain('Log activity');
    expect(doc.getElementById('lead-activity-form')).toBeNull();
    expect(doc.querySelector('a[href="#lead-activity-form"]')).toBeNull();
    const logPanel = card(doc, 'Log activity');
    const history = card(doc, 'History');
    expect(logPanel.parentElement).toBe(history.parentElement);
    expect(
      history.compareDocumentPosition(logPanel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('reads stage-change dates for the progression from the logged list', async () => {
    const doc = await render();
    const timeline = doc.querySelector('[aria-label="Lead progression"]');
    expect(timeline?.textContent).toContain('Contacted');
    expect(timeline?.textContent).not.toMatch(/Contacted\s*Not yet/);
  });
});

describe('lead detail names (D46: each record carries its own names)', () => {
  it('names an assignee outside an own-scope owners list from the activity', async () => {
    mocks.listLeadOwners.mockResolvedValue([OWNERS[0]]);
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(
        opts.status === 'planned'
          ? [{ ...PLANNED, assigneeUserId: OTHER, assigneeName: 'Mira Thapa' }]
          : [LOGGED],
      ),
    );
    const followUps = card(await render(), 'Follow-ups').textContent ?? '';
    expect(followUps).toContain('Mira Thapa');
    expect(followUps).not.toContain('Another teammate');
  });

  it('keeps History actors and assignees named when the owners list is refused and no directory is read', async () => {
    mocks.listLeadOwners.mockRejectedValue(new ApiError(403, 'Forbidden'));
    const doc = await render();
    expect(mocks.userNames).not.toHaveBeenCalled();
    expect(card(doc, 'History').textContent).toContain('Anil Karki');
    expect(card(doc, 'Follow-ups').textContent).toContain('Anil Karki');
  });

  it('shows the owner by name and never an id or a placeholder, whatever the directory does', async () => {
    mocks.listLeadOwners.mockRejectedValue(new ApiError(403, 'Forbidden'));
    mocks.userNames.mockRejectedValue(new Error('directory down'));
    const doc = await render();
    const text = doc.body.textContent ?? '';
    expect(text).toContain('Anil Karki');
    expect(text).not.toContain('Another teammate');
    expect(text).not.toContain('Name unavailable');
    expect(text).not.toContain(OWNER);
  });
});

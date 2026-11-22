// @vitest-environment jsdom
import {
  formatPartyPhoneForPrint,
  type ActivityDto,
  type LeadDto,
  type LeadOwnerOption,
} from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkContactedDialog } from '@/components/p2/crm/mark-contacted-dialog';
import { StageConfirmDialog } from '@/components/p2/crm/stage-confirm-dialog';
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
  updateLeadContactAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The real dialogs render; the spies record which one each header action uses and with what props.
vi.mock('@/components/p2/crm/mark-contacted-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/p2/crm/mark-contacted-dialog')>();
  return { ...actual, MarkContactedDialog: vi.fn(actual.MarkContactedDialog) };
});
vi.mock('@/components/p2/crm/convert-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/p2/crm/convert-dialog')>();
  return { ...actual, ConvertDialog: vi.fn(actual.ConvertDialog) };
});
vi.mock('@/components/p2/crm/stage-confirm-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/p2/crm/stage-confirm-dialog')>();
  return { ...actual, StageConfirmDialog: vi.fn(actual.StageConfirmDialog) };
});

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
  country: 'NP',
  phones: [],
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
    .mockImplementation((_session: unknown, opts: { status?: string; kind?: string }) =>
      Promise.resolve(
        opts.status === 'planned'
          ? [PLANNED]
          : opts.status === 'logged'
            ? [LOGGED, STAGE_CHANGE]
            : opts.kind === 'stage_change'
              ? [STAGE_CHANGE]
              : [],
      ),
    );
  mocks.listLeadOwners.mockReset().mockResolvedValue(OWNERS);
  mocks.userNames.mockReset().mockResolvedValue(new Map());
  mocks.listLeadLostReasonChoices.mockReset().mockResolvedValue([]);
  vi.mocked(MarkContactedDialog).mockClear();
  vi.mocked(StageConfirmDialog).mockClear();
});

describe('lead country and phones (FX9)', () => {
  const PHONES: LeadDto['phones'] = [
    { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
    { country: 'NP', e164: '+9779812345678', isPrimary: false },
  ];

  it('shows the primary number, formatted, and the country by name', async () => {
    mocks.getLead.mockResolvedValue(lead({ country: 'US', phones: PHONES }));
    const overview = card(await render(), 'Lead overview').textContent ?? '';
    expect(overview).toContain(formatPartyPhoneForPrint('+14155552671'));
    expect(overview).not.toContain(formatPartyPhoneForPrint('+9779812345678'));
    expect(overview).toContain('United States');
  });

  it('says Not set without a number, and offers the editor to an editor', async () => {
    const overview = card(await render(), 'Lead overview');
    expect(overview.textContent).toContain('Not set');
    expect(overview.textContent).toContain('Edit country and phones');
  });

  it('offers no editor on a read-only or converted lead', async () => {
    mocks.getLead.mockResolvedValue(lead({ canEdit: false, allowedMoves: [], phones: PHONES }));
    expect(card(await render(), 'Lead overview').textContent).not.toContain(
      'Edit country and phones',
    );
    mocks.getLead.mockResolvedValue(lead({ stage: 'converted', allowedMoves: [] }));
    expect(card(await render(), 'Lead overview').textContent).not.toContain(
      'Edit country and phones',
    );
  });

  it("hands the convert dialog the lead's country and numbers", async () => {
    const { ConvertDialog } = await import('@/components/p2/crm/convert-dialog');
    mocks.getLead.mockResolvedValue(
      lead({
        stage: 'qualified',
        allowedMoves: ['on_hold', 'lost'],
        country: 'US',
        phones: PHONES,
      }),
    );
    await render();
    const handed = vi.mocked(ConvertDialog).mock.calls.at(-1)?.[0].lead;
    expect(handed).toMatchObject({ country: 'US', phones: PHONES });
    expect(handed).not.toHaveProperty('phone');
  });
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
    [true, 'Use Log activity to record a call, meeting, email or note.'],
    [false, 'Calls, meetings, emails and notes logged on this lead show here.'],
  ])('names the lead in an empty History (canEdit %s)', async (canEdit, hint) => {
    mocks.getLead.mockResolvedValue(lead({ canEdit }));
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(opts.status === 'planned' ? [PLANNED] : []),
    );
    const history = card(await render(), 'History').textContent ?? '';
    expect(history).toContain('No activities on this lead yet');
    expect(history).toContain(hint);
    expect(history).not.toContain('No activity yet');
  });

  it.each([
    [
      'new',
      ['contacted', 'on_hold', 'lost'] as LeadDto['stage'][],
      ['Mark contacted', 'Put on hold', 'Mark lost'],
      'Log a call, email or meeting with Mark contacted to move this lead to Contacted.',
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
      ['Convert to opportunity', 'Put on hold', 'Mark lost'],
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
    ['lost', [] as LeadDto['stage'][], [], 'This lead is lost. Reopening needs reopen access.'],
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
    mocks.listActivities.mockImplementation(
      (_s: unknown, opts: { status?: string; kind?: string }) =>
        Promise.resolve(
          opts.status === 'logged' || opts.kind === 'stage_change'
            ? [holdChange, STAGE_CHANGE, LOGGED]
            : [],
        ),
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
    // No Convert for a read-only viewer: not in the header, and no side panel left to explain it.
    expect(doc.body.textContent).not.toContain('Convert to opportunity');
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
    mocks.listActivities.mockImplementation(
      (_s: unknown, opts: { status?: string; kind?: string }) =>
        Promise.resolve(opts.kind === 'stage_change' ? [olderContacted, newerContacted] : []),
    );
    const doc = await render();
    expect(card(doc, 'Lead overview').textContent).not.toContain('Save owner');
    const timelineText = doc.querySelector('[aria-label="Lead progression"]')?.textContent ?? '';
    expect(timelineText).toContain('18 Nov 2026');
    expect(timelineText).not.toContain('09 Nov 2026');
  });

  it('offers Convert in the header of a qualified lead, with no conversion side panel', async () => {
    mocks.getLead.mockResolvedValue(
      lead({ stage: 'qualified', allowedMoves: ['on_hold', 'lost'] }),
    );
    const doc = await render();
    expect(headerButtons(doc)[0]).toBe('Convert to opportunity');
    expect(doc.getElementById('lead-conversion')).toBeNull();
    expect(doc.body.textContent).not.toContain('Qualify this lead to unlock conversion');
  });

  it('shows no Convert before Qualified, and a link to the opportunity once converted', async () => {
    mocks.getLead.mockResolvedValue(lead({ stage: 'contacted', allowedMoves: ['qualified'] }));
    let doc = await render();
    expect(doc.body.textContent).not.toContain('Convert to opportunity');
    expect(doc.getElementById('lead-conversion')).toBeNull();

    const opportunityId = '44444444-4444-4444-8444-444444444444';
    mocks.getLead.mockResolvedValue(
      lead({ stage: 'converted', allowedMoves: [], convertedOpportunityId: opportunityId }),
    );
    doc = await render();
    expect(headerButtons(doc)).toEqual([]);
    const panel = card(doc, 'Opportunity');
    expect(panel.querySelector(`a[href="/opportunities/${opportunityId}"]`)?.textContent).toContain(
      'Open the opportunity',
    );
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

  it('reads the progression from the stage history, asked for on its own', async () => {
    const doc = await render();
    expect(mocks.listActivities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: LEAD, kind: 'stage_change' }),
    );
    const timeline = doc.querySelector('[aria-label="Lead progression"]');
    expect(timeline?.textContent).toContain('Contacted');
    expect(timeline?.textContent).not.toMatch(/Contacted\s*Not yet/);
  });

  /** Each timeline step's title and status, in order. */
  const steps = (doc: Document) =>
    [...doc.querySelectorAll('[aria-label="Lead progression"] > li')].map((li) => li.textContent);

  it('marks a lost lead reached only where it went, never by position', async () => {
    // Lost straight from New: nothing between New and Lost happened.
    const lostChange = activity('33333333-3333-4333-8333-333333333337', {
      kind: 'stage_change',
      subject: 'Stage changed from new to lost',
      occurredAt: '2026-11-10T05:45:00.000Z',
    });
    mocks.getLead.mockResolvedValue(lead({ stage: 'lost', allowedMoves: [] }));
    mocks.listActivities.mockImplementation((_s: unknown, opts: { kind?: string }) =>
      Promise.resolve(opts.kind === 'stage_change' ? [lostChange] : []),
    );
    const timeline = steps(await render());
    expect(timeline[1]).toMatch(/Contacted\s*Not yet/);
    expect(timeline[2]).toMatch(/Qualified\s*Not yet/);
    expect(timeline.at(-1)).toMatch(/Lost/);
  });

  it('marks the stage a lead was held at, and what came before it, without a recorded move (F1-Q53)', async () => {
    mocks.getLead.mockResolvedValue(
      lead({ stage: 'on_hold', heldFromStage: 'qualified', allowedMoves: ['qualified'] }),
    );
    mocks.listActivities.mockResolvedValue([]);
    const timeline = steps(await render());
    expect(timeline[1]).toMatch(/Contacted\s*Reached/);
    expect(timeline[2]).toMatch(/Qualified\s*Reached/);
    expect(timeline[3]).toMatch(/Converted\s*Not yet/);
  });

  it('still draws what the lead itself proves when the stage history fails to load', async () => {
    mocks.getLead.mockResolvedValue(lead({ stage: 'qualified', allowedMoves: ['on_hold'] }));
    mocks.listActivities.mockImplementation((_s: unknown, opts: { kind?: string }) =>
      opts.kind === 'stage_change'
        ? Promise.reject(new ApiError(500, 'Server error'))
        : Promise.resolve([]),
    );
    const timeline = steps(await render());
    expect(timeline[1]).toMatch(/Contacted\s*Reached/);
    expect(timeline[2]).toMatch(/Qualified\s*Current/);
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

describe('every move to Contacted logs a contact first (FR-6, D48)', () => {
  const NOTE = activity('33333333-3333-4333-8333-333333333338', {
    kind: 'note',
    subject: 'Budget note',
  });
  const MEETING = activity('33333333-3333-4333-8333-333333333339', {
    kind: 'meeting',
    subject: 'Site visit',
  });

  /** The logged list answers with `logged`; the other lists answer with nothing. */
  const loggedIs = (logged: ActivityDto[] | 'fails') =>
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      opts.status === 'logged'
        ? logged === 'fails'
          ? Promise.reject(new ApiError(500, 'Server error'))
          : Promise.resolve(logged)
        : Promise.resolve([]),
    );
  const heldAt = (stage: LeadDto['stage']) =>
    lead({ stage: 'on_hold', heldFromStage: stage, allowedMoves: [stage] });
  const lostLead = () => lead({ stage: 'lost', allowedMoves: ['contacted'] });
  const contactedProps = () => vi.mocked(MarkContactedDialog).mock.calls.map(([props]) => props);
  const confirmProps = () => vi.mocked(StageConfirmDialog).mock.calls.map(([props]) => props);

  it('Mark contacted on a New lead logs the contact, and the Stage panel names a meeting too', async () => {
    loggedIs([]);
    const doc = await render();
    expect(contactedProps()).toEqual([
      expect.objectContaining({ id: LEAD, number: 'LD-2026-0019', version: 3 }),
    ]);
    expect(contactedProps()[0]?.fromLabel).toBeUndefined();
    expect(confirmProps()).toEqual([]);
    expect(card(doc, 'Stage').textContent).toContain(
      'Log a call, email or meeting with Mark contacted to move this lead to Contacted.',
    );
  });

  it.each([
    ['nothing logged', [] as ActivityDto[]],
    ['only a note and a stage change logged', [NOTE, STAGE_CHANGE]],
  ])('Resume to Contacted logs the contact when %s', async (_label, logged) => {
    mocks.getLead.mockResolvedValue(heldAt('contacted'));
    loggedIs(logged);
    const doc = await render();
    expect(headerButtons(doc)).toEqual(['Resume']);
    expect(contactedProps()).toEqual([
      expect.objectContaining({
        id: LEAD,
        number: 'LD-2026-0019',
        version: 3,
        triggerLabel: 'Resume',
        fromLabel: 'On Hold',
        title: 'Resume this lead?',
        confirmLabel: 'Resume lead',
      }),
    ]);
    expect(confirmProps()).toEqual([]);
  });

  it.each([
    ['nothing logged', [] as ActivityDto[]],
    ['the logged list failed to load', 'fails' as const],
  ])('Reopen to Contacted logs the contact when %s', async (_label, logged) => {
    mocks.getLead.mockResolvedValue(lostLead());
    loggedIs(logged);
    const doc = await render();
    expect(headerButtons(doc)).toEqual(['Reopen']);
    expect(contactedProps()).toEqual([
      expect.objectContaining({
        id: LEAD,
        number: 'LD-2026-0019',
        version: 3,
        triggerLabel: 'Reopen',
        fromLabel: 'Lost',
        title: 'Reopen this lead?',
        confirmLabel: 'Reopen lead',
      }),
    ]);
    expect(confirmProps()).toEqual([]);
  });

  it.each([
    ['Resume', heldAt('contacted')],
    ['Reopen', lostLead()],
  ])('%s keeps the plain confirm when a meeting is already logged', async (label, held) => {
    mocks.getLead.mockResolvedValue(held);
    loggedIs([NOTE, MEETING]);
    const doc = await render();
    expect(headerButtons(doc)).toEqual([label]);
    expect(contactedProps()).toEqual([]);
    expect(confirmProps()).toEqual([
      expect.objectContaining({ stage: 'contacted', triggerLabel: label }),
    ]);
  });

  it('Resume to Qualified keeps the plain confirm: only Contacted needs the contact', async () => {
    mocks.getLead.mockResolvedValue(heldAt('qualified'));
    loggedIs([]);
    await render();
    expect(contactedProps()).toEqual([]);
    expect(confirmProps()).toEqual([
      expect.objectContaining({ stage: 'qualified', triggerLabel: 'Resume' }),
    ]);
  });
});

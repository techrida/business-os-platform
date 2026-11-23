// @vitest-environment jsdom
import { CreditHoldDtoSchema, type OpportunityDto, type QuotationListItem } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { START_QUOTATION_REFUSED } from '@/components/p2/quotations/opportunity-gate';
import { ApiError } from '@/lib/api';

import OpportunityPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getOpportunity: vi.fn(),
  listActivities: vi.fn(),
  listLeadOwners: vi.fn(),
  listOpportunityOwners: vi.fn(),
  listOpportunityFollowUpAssignees: vi.fn(),
  getCustomer: vi.fn(),
  listQuotations: vi.fn(),
  listOpportunityLostReasonChoices: vi.fn(),
  userNames: vi.fn(),
  getMeOrNull: vi.fn(),
  getPermissionCheck: vi.fn(),
  getCreditHold: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/live-permissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMeOrNull: mocks.getMeOrNull,
  getPermissionCheck: mocks.getPermissionCheck,
}));
// The live grants come from GET /v1/me; when it fails the page falls back to the role defaults.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMe: mocks.getMe,
}));
vi.mock('@/lib/api-lead-lost-reasons', () => ({
  listOpportunityLostReasonChoices: mocks.listOpportunityLostReasonChoices,
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getOpportunity: mocks.getOpportunity,
  listActivities: mocks.listActivities,
  listLeadOwners: mocks.listLeadOwners,
  listOpportunityOwners: mocks.listOpportunityOwners,
  listOpportunityFollowUpAssignees: mocks.listOpportunityFollowUpAssignees,
  getCreditHold: mocks.getCreditHold,
}));
vi.mock('@/components/p2/customers/api', () => ({ getCustomer: mocks.getCustomer }));
vi.mock('@/components/p2/quotations/api', () => ({ listQuotations: mocks.listQuotations }));
vi.mock('@/lib/business-labels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userNames: mocks.userNames,
}));
vi.mock('@/app/(app)/leads/actions', () => ({
  completeFollowUpAction: vi.fn(),
  rescheduleFollowUpAction: vi.fn(),
  cancelFollowUpAction: vi.fn(),
  scheduleFollowUpAction: vi.fn(),
}));
vi.mock('../../activities/actions', () => ({ logActivityAction: vi.fn() }));
vi.mock('../actions', () => ({
  moveOpportunityStageAction: vi.fn(),
  updateOpportunityOwnerAction: vi.fn(),
  overrideCreditHoldAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const OPP = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const Q1 = '55555555-5555-4555-8555-555555555551';
const Q2 = '55555555-5555-4555-8555-555555555552';
const WHEN = '2026-11-08T05:45:00.000Z';

const DEFAULT_MOVES: Record<OpportunityDto['stage'], OpportunityDto['stage'][]> = {
  qualified: ['requirement_received', 'lost'],
  requirement_received: ['proposal_sent', 'lost'],
  proposal_sent: ['lost'],
  quotation_sent: ['negotiation', 'lost'],
  negotiation: ['on_hold', 'lost'],
  on_hold: ['negotiation'],
  lost: [],
  won: [],
};

const opportunity = (
  stage: OpportunityDto['stage'] = 'qualified',
  over: Partial<OpportunityDto> = {},
): OpportunityDto => ({
  id: OPP,
  number: 'DEAL-0001',
  name: 'Bridge works',
  customerId: CUSTOMER,
  contactId: null,
  leadId: null,
  ownerUserId: null,
  ownerName: null,
  stage,
  stageReason: null,
  lostReason: null,
  stageNote: null,
  value: null,
  currency: 'NPR',
  probability: null,
  expectedClose: null,
  wonQuotationVersionId: null,
  allowedMoves: DEFAULT_MOVES[stage],
  canEdit: true,
  canDraftQuotation: true,
  version: 1,
  createdAt: WHEN,
  updatedAt: WHEN,
  ...over,
});

const quote = (id: string, over: Partial<QuotationListItem> = {}) =>
  ({
    id,
    number: `QT-${id.slice(-1)}`,
    currency: 'NPR',
    total: '12500.00',
    validUntil: '2026-11-30',
    status: 'draft',
    canEdit: true,
    ...over,
  }) as QuotationListItem;

async function render(): Promise<string> {
  return renderToStaticMarkup(await OpportunityPage({ params: Promise.resolve({ id: OPP }) }));
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Every link-button in the page header, as [label, href]. */
function headerLinks(html: string): [string, string][] {
  return [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .map((m) => [m[2] ?? '', (m[1] ?? '').replaceAll('&amp;', '&')] as [string, string])
    .filter(([label]) => /quotation|draft/i.test(label));
}

/** Stage action buttons in the page header, by label. */
function headerStageButtons(doc: Document): string[] {
  const header = doc.querySelector('h1')?.parentElement?.parentElement?.parentElement;
  if (!header) throw new Error('PageHeader container not found');
  return [...header.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.getOpportunity.mockReset().mockResolvedValue(opportunity());
  mocks.listActivities.mockReset().mockResolvedValue([]);
  mocks.listLeadOwners.mockReset().mockResolvedValue([]);
  mocks.listOpportunityOwners.mockReset().mockResolvedValue([]);
  mocks.listOpportunityFollowUpAssignees.mockReset().mockResolvedValue([]);
  mocks.getCustomer.mockReset().mockResolvedValue(null);
  mocks.listQuotations.mockReset().mockResolvedValue([]);
  mocks.listOpportunityLostReasonChoices.mockReset().mockResolvedValue([]);
  mocks.userNames.mockReset().mockResolvedValue(new Map());
  mocks.getMeOrNull.mockReset().mockResolvedValue(null);
  mocks.getPermissionCheck
    .mockReset()
    .mockImplementation(
      async (...args: Parameters<typeof import('@/lib/live-permissions').getPermissionCheck>) =>
        (
          await vi.importActual<typeof import('@/lib/live-permissions')>('@/lib/live-permissions')
        ).getPermissionCheck(...args),
    );
  mocks.getCreditHold.mockReset();
  mocks.getMe.mockReset().mockRejectedValue(new Error('down'));
});

/** The live grants `/v1/me` reports, each at `all`. */
const liveGrants = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

describe('opportunity quotation actions (demo feedback: New quotation made four quotations)', () => {
  it("asks the API only for this opportunity's quotations", async () => {
    await render();
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), { opportunityId: OPP });
  });

  it('offers New quotation when there is no draft to resume', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'sent', canEdit: false })]);
    expect(headerLinks(await render())).toEqual([
      ['View quotations', `/quotations?opportunityId=${OPP}`],
      ['New quotation', `/quotations/new?opportunityId=${OPP}`],
    ]);
  });

  it('offers Edit quotation, and no New quotation, when one draft can be resumed', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'returned' })]);
    const html = await render();
    expect(headerLinks(html)).toEqual([
      ['View quotations', `/quotations?opportunityId=${OPP}`],
      ['Edit quotation', `/quotations/${Q1}/edit`],
    ]);
    expect(html).toContain('aria-label="Edit quotation QT-1"');
  });

  it('sends the person to the list to choose when several drafts can be edited', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1), quote(Q2)]);
    expect(headerLinks(await render())).toEqual([
      ['New quotation', `/quotations/new?opportunityId=${OPP}&another=1`],
      ['Choose a draft (2)', `/quotations?opportunityId=${OPP}`],
    ]);
  });

  it('falls back to New quotation when the list does not load', async () => {
    mocks.listQuotations.mockRejectedValue(new ApiError(500, 'down'));
    expect(headerLinks(await render())).toContainEqual([
      'New quotation',
      `/quotations/new?opportunityId=${OPP}`,
    ]);
  });

  it('shows only View quotations when the server says the caller may not quote on this deal (FX-Q2)', async () => {
    // A colleague who only holds a follow-up on the deal: they hold quotation.draft, but not the reach.
    mocks.getOpportunity.mockResolvedValue(opportunity('qualified', { canDraftQuotation: false }));
    mocks.listQuotations.mockResolvedValue([quote(Q1)]);
    expect(headerLinks(await render())).toEqual([
      ['View quotations', `/quotations?opportunityId=${OPP}`],
    ]);
  });

  it('keeps New quotation off an open deal the server refuses, with no caption the server refuses (R4a Q4 a)', async () => {
    mocks.getOpportunity.mockResolvedValue(opportunity('qualified', { canDraftQuotation: false }));
    const html = await render();
    expect(headerLinks(html).map(([label]) => label)).toEqual(['View quotations']);
    // UIP-FORM-011: the reason is the View quotations tooltip, not a caption beside it.
    expect(parse(html).body.textContent).not.toContain(START_QUOTATION_REFUSED);

    // Allowed, or a closed deal: nothing to explain.
    mocks.getOpportunity.mockResolvedValue(opportunity('qualified', { canDraftQuotation: true }));
    expect(parse(await render()).body.textContent).not.toContain(START_QUOTATION_REFUSED);
    mocks.getOpportunity.mockResolvedValue(opportunity('won', { canDraftQuotation: false }));
    expect(parse(await render()).body.textContent).not.toContain(START_QUOTATION_REFUSED);
  });

  it('fails closed to View quotations when canDraftQuotation is omitted', async () => {
    const { canDraftQuotation: _omitted, ...rest } = opportunity('qualified');
    mocks.getOpportunity.mockResolvedValue(rest);
    expect(headerLinks(await render()).map(([label]) => label)).toEqual(['View quotations']);
  });

  it("offers New quotation to the lead's creator the server lets quote, without deal write access (FX-Q1)", async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['finance'] });
    mocks.getOpportunity.mockResolvedValue(
      opportunity('qualified', { canEdit: false, allowedMoves: [], canDraftQuotation: true }),
    );
    expect(headerLinks(await render()).map(([label]) => label)).toEqual([
      'View quotations',
      'New quotation',
    ]);
  });

  it('offers no New quotation on a won opportunity, but still resumes a draft', async () => {
    mocks.getOpportunity.mockResolvedValue(opportunity('won'));
    expect(headerLinks(await render()).map(([label]) => label)).toEqual(['View quotations']);
    mocks.listQuotations.mockResolvedValue([quote(Q1)]);
    expect(headerLinks(await render()).map(([label]) => label)).toEqual([
      'View quotations',
      'Edit quotation',
    ]);
  });

  it('links associated quotations and highlights the accepted version that won the deal', async () => {
    mocks.getOpportunity.mockResolvedValue({
      ...opportunity('won'),
      wonQuotationVersionId: Q1,
    });
    mocks.listQuotations.mockResolvedValue([
      quote(Q1, { currentVersionId: Q1, status: 'accepted', canEdit: false }),
      quote(Q2, { currentVersionId: Q2, status: 'sent', canEdit: false }),
    ]);

    const html = await render();
    expect(html).toContain('<caption class="sr-only">Opportunity quotations</caption>');
    expect(html).toContain(`href="/quotations/${Q1}">QT-1</a>`);
    expect(html).toContain(`href="/quotations/${Q2}">QT-2</a>`);
    expect(html).toContain('data-accepted="true"');
    expect(html).not.toContain('name="stage"');
  });
});

describe('opportunity follow-ups (migrated open tasks on the deal)', () => {
  const ASSIGNEE = '77777777-7777-4777-8777-777777777777';
  const planned = {
    id: '66666666-6666-4666-8666-666666666666',
    kind: 'call',
    subject: 'Chase the signed scope',
    body: null,
    leadId: null,
    opportunityId: OPP,
    customerId: null,
    contactId: null,
    quotationId: null,
    dueAt: '2099-01-02T04:00:00.000Z',
    assigneeUserId: ASSIGNEE,
    assigneeName: 'Mira Thapa',
    completedAt: null,
    cancelledAt: null,
    planned: true,
    createdByUserId: null,
    createdByName: null,
    occurredAt: WHEN,
    version: 2,
    can: { complete: true, reschedule: true, cancel: true },
  };

  beforeEach(() => {
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(opts.status === 'planned' ? [planned] : []),
    );
  });

  /** The Activities panel's section under the heading `name` (Planned or History). */
  const section = (doc: Document, name: string) =>
    [...doc.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === name) ??
    null;

  it('lists planned rows under Activities, apart from History, with no Follow-ups card (U16-Q6)', async () => {
    const doc = parse(await render());
    expect(mocks.listActivities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ opportunityId: OPP, status: 'planned' }),
    );
    expect([...doc.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain('Follow-ups');
    const plannedSection = section(doc, 'Planned');
    expect(plannedSection?.textContent).toContain('Chase the signed scope');
    for (const action of ['Complete', 'Reschedule', 'Cancel']) {
      expect(
        plannedSection?.querySelector(`[aria-label="${action} Chase the signed scope"]`),
      ).not.toBeNull();
    }
    expect(section(doc, 'History')?.textContent).not.toContain('Chase the signed scope');
  });

  it.each([
    [true, 'Use Log activity to record a call, meeting, email or note.'],
    [false, 'Calls, meetings, emails and notes logged on this opportunity show here.'],
  ])('names the opportunity in an empty History (canEdit %s)', async (canEdit, hint) => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', canEdit ? {} : { canEdit: false, allowedMoves: [] }),
    );
    const history = section(parse(await render()), 'History')?.textContent ?? '';
    expect(history).toContain('No activities on this opportunity yet');
    expect(history).toContain(hint);
    expect(history).not.toContain('No activity yet');
  });

  it('offers Schedule follow-up and Log activity to an editor in the Activities header', async () => {
    const SITA = '66666666-6666-4666-8666-666666666661';
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', { ownerUserId: SITA, ownerName: 'Sita Rai' }),
    );
    mocks.listOpportunityOwners.mockResolvedValue([
      { userId: SITA, displayName: 'Sita Rai', email: '' },
      { userId: ASSIGNEE, displayName: 'Mira Thapa', email: '' },
    ]);
    const html = await render();
    expect(html).toContain('Schedule follow-up');
    expect(html).toContain('Log activity');
  });

  // F1-Q51: an owner must write deals, a follow-up's assignee need only read them, so the follow-ups
  // take their own list and a read-only assignee keeps their place (and picture) there.
  it('gives follow-ups their own assignee list, apart from the owner choices', async () => {
    const SITA = '66666666-6666-4666-8666-666666666661';
    const AVATAR = '88888888-8888-4888-8888-888888888888';
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', { ownerUserId: SITA, ownerName: 'Sita Rai' }),
    );
    const sita = { userId: SITA, displayName: 'Sita Rai', email: '', avatarDocumentId: null };
    mocks.listOpportunityOwners.mockResolvedValue([sita]);
    mocks.listOpportunityFollowUpAssignees.mockResolvedValue([
      sita,
      { userId: ASSIGNEE, displayName: 'Mira Thapa', email: '', avatarDocumentId: AVATAR },
    ]);
    const doc = parse(await render());
    expect(mocks.listOpportunityOwners).toHaveBeenCalledTimes(1);
    expect(mocks.listOpportunityFollowUpAssignees).toHaveBeenCalledTimes(1);
    const images = [...(section(doc, 'Planned')?.querySelectorAll('img') ?? [])];
    expect(images.map((img) => img.getAttribute('src'))).toEqual([expect.stringContaining(AVATAR)]);
  });

  it("shows a lead's follow-up carried at convert, and lets its assignee complete it without edit access", async () => {
    const carried = {
      ...planned,
      subject: 'Send the revised scope',
      assigneeUserId: ASSIGNEE,
      can: { complete: true, reschedule: false, cancel: false },
    };
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(opts.status === 'planned' ? [carried] : []),
    );
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', { canEdit: false, allowedMoves: [] }),
    );
    mocks.getMeOrNull.mockResolvedValue({ id: ASSIGNEE });
    const doc = parse(await render());
    const plannedSection = section(doc, 'Planned');
    expect(plannedSection?.textContent).toContain('Send the revised scope');
    expect(
      plannedSection?.querySelector('[aria-label="Complete Send the revised scope"]'),
    ).not.toBeNull();
    expect(
      plannedSection?.querySelector('[aria-label="Reschedule Send the revised scope"]'),
    ).toBeNull();
    expect(doc.body.textContent).not.toContain('Schedule follow-up');
  });

  it('names the assignee from the activity itself, never by id or directory', async () => {
    const html = await render();
    expect(html).toContain('Mira Thapa');
    expect(html).not.toContain('Another teammate');
    expect(html).not.toContain(`>${ASSIGNEE}<`);
  });

  it('does not ask for the owners list without edit access, and still renders', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', { canEdit: false, allowedMoves: [] }),
    );
    const html = await render();
    expect(mocks.listOpportunityOwners).not.toHaveBeenCalled();
    expect(mocks.listOpportunityFollowUpAssignees).not.toHaveBeenCalled();
    expect(mocks.listLeadOwners).not.toHaveBeenCalled();
    expect(html).toContain('Chase the signed scope');
    expect(html).toContain('Mira Thapa');
    expect(html).not.toContain('Another teammate');
  });

  // The deal's owners list (F1-Q51) is asked for with edit access. When the deal carries no canEdit, that comes
  // from the saved grants `/v1/me` reports, not the role defaults.
  it("asks for the deal's owners when the saved grants add crm.opportunity.write to a role without it", async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'live-1', roles: ['management'] });
    mocks.getMe.mockResolvedValue(liveGrants('crm.opportunity.read', 'crm.opportunity.write'));
    mocks.getOpportunity.mockResolvedValue(opportunity('negotiation', { canEdit: undefined }));
    await render();
    expect(mocks.listOpportunityOwners).toHaveBeenCalledTimes(1);
    expect(mocks.listLeadOwners).not.toHaveBeenCalled();
  });

  it("skips the deal's owners when the saved grants removed crm.opportunity.write from sales", async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'live-2', roles: ['sales'] });
    mocks.getMe.mockResolvedValue(liveGrants('crm.opportunity.read', 'crm.lead.write'));
    mocks.getOpportunity.mockResolvedValue(opportunity('negotiation', { canEdit: undefined }));
    const html = await render();
    expect(mocks.listOpportunityOwners).not.toHaveBeenCalled();
    expect(mocks.listLeadOwners).not.toHaveBeenCalled();
    expect(html).toContain('Chase the signed scope');
  });

  it('says the follow-ups did not load instead of showing an empty card', async () => {
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      opts.status === 'planned' ? Promise.reject(new ApiError(503, 'down')) : Promise.resolve([]),
    );
    const doc = parse(await render());
    expect(section(doc, 'Planned')?.textContent).toContain('Follow-ups did not load');
    expect(doc.body.textContent).not.toContain('Nothing planned.');
  });
});

describe('opportunity stage action buttons, timeline and read-only hygiene', () => {
  const LOST_REASON = '88888888-8888-4888-8888-888888888888';

  it('renders no Move to dropdown or stage select anywhere on the page', async () => {
    const doc = parse(await render());
    expect(doc.body.textContent).not.toContain('Move to');
    expect(doc.querySelector('select[name="stage"]')).toBeNull();
    expect(doc.querySelector('input[name="stage"]')).toBeNull();
  });

  it.each([
    [
      'qualified',
      ['requirement_received', 'lost'] as OpportunityDto['stage'][],
      ['Requirement received', 'Mark lost'],
      'Sending and accepting quotations update the stage automatically.',
    ],
    [
      'requirement_received',
      ['proposal_sent', 'lost'] as OpportunityDto['stage'][],
      ['Proposal sent', 'Mark lost'],
      'Sending and accepting quotations update the stage automatically.',
    ],
    [
      'proposal_sent',
      ['lost'] as OpportunityDto['stage'][],
      ['Mark lost'],
      'Sending and accepting quotations update the stage automatically.',
    ],
    [
      'quotation_sent',
      ['negotiation', 'lost'] as OpportunityDto['stage'][],
      ['Move to negotiation', 'Mark lost'],
      'Sending and accepting quotations update the stage automatically.',
    ],
    [
      'negotiation',
      ['on_hold', 'lost'] as OpportunityDto['stage'][],
      ['Put on hold', 'Mark lost'],
      'Sending and accepting quotations update the stage automatically.',
    ],
    [
      'on_hold',
      ['negotiation'] as OpportunityDto['stage'][],
      ['Resume'],
      'This opportunity is on hold. Use Resume in the header to take it off hold.',
    ],
    [
      'lost',
      [] as OpportunityDto['stage'][],
      [],
      'This opportunity is lost. Reopening needs reopen access.',
    ],
    [
      'lost',
      ['qualified'] as OpportunityDto['stage'][],
      ['Reopen'],
      'This opportunity is lost. Use Reopen in the header to return it to Qualified.',
    ],
    ['won', [] as OpportunityDto['stage'][], [], 'This opportunity is won. Its stage is final.'],
  ])(
    'renders header stage buttons and Stage card guidance for %s with allowedMoves %j',
    async (stage, allowedMoves, expectedButtons, expectedText) => {
      mocks.getOpportunity.mockResolvedValue(
        opportunity(stage as OpportunityDto['stage'], { allowedMoves }),
      );
      const html = await render();
      const doc = parse(html);
      expect(headerStageButtons(doc)).toEqual(expectedButtons);
      expect(doc.querySelector('[aria-label="Stage"]')?.textContent).toContain(expectedText);

      if (allowedMoves.includes('lost')) {
        expect(mocks.listOpportunityLostReasonChoices).toHaveBeenCalledOnce();
      } else {
        expect(mocks.listOpportunityLostReasonChoices).not.toHaveBeenCalled();
      }
    },
  );

  it('demotes the quotation CTA to secondary when a primary stage button is present, and keeps it primary otherwise', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('qualified', { allowedMoves: ['requirement_received', 'lost'] }),
    );
    const qualifiedDoc = parse(await render());
    const qualifiedHeader =
      qualifiedDoc.querySelector('h1')?.parentElement?.parentElement?.parentElement;
    const newQuoteWhenPrimaryStage = [...(qualifiedHeader?.querySelectorAll('a') ?? [])].find(
      (a) => a.textContent?.trim() === 'New quotation',
    );
    const reqButton = [...(qualifiedHeader?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Requirement received',
    );
    expect(newQuoteWhenPrimaryStage?.className).toContain('secondary');
    expect(reqButton?.className).toContain('primary');

    mocks.getOpportunity.mockResolvedValue(
      opportunity('proposal_sent', { allowedMoves: ['lost'] }),
    );
    const proposalDoc = parse(await render());
    const proposalHeader =
      proposalDoc.querySelector('h1')?.parentElement?.parentElement?.parentElement;
    const newQuoteWhenNoPrimaryStage = [...(proposalHeader?.querySelectorAll('a') ?? [])].find(
      (a) => a.textContent?.trim() === 'New quotation',
    );
    expect(newQuoteWhenNoPrimaryStage?.className).toContain('primary');
  });

  /** Each timeline step as "class: text", so the tone and the words are checked together. */
  const timeline = async () =>
    [...parse(await render()).querySelectorAll('[aria-label="Opportunity stages"] > li')].map(
      (li) =>
        `${/(done|current|upcoming|muted|warning|error)/.exec(li.className)?.[1]}: ${(
          li.textContent ?? ''
        ).replace(/^Step \d+: /, '')}`,
    );

  it('marks only the stages a deal is known to have reached, never by position', async () => {
    // Quotation Sent can come straight from Qualified, so the two stages between are unknown.
    mocks.getOpportunity.mockResolvedValue(opportunity('quotation_sent'));
    expect(await timeline()).toEqual([
      'done: QualifiedReached',
      'muted: Requirement ReceivedNot recorded',
      'muted: Proposal SentNot recorded',
      'current: Quotation SentCurrent',
      'upcoming: NegotiationNot yet',
      'upcoming: WonNot yet',
    ]);

    // Proposal Sent has one way in, so Requirement Received was reached.
    mocks.getOpportunity.mockResolvedValue(opportunity('proposal_sent'));
    expect((await timeline()).slice(0, 3)).toEqual([
      'done: QualifiedReached',
      'done: Requirement ReceivedReached',
      'current: Proposal SentCurrent',
    ]);

    // Won: a quotation was sent and accepted; whether it went through Negotiation is not known.
    mocks.getOpportunity.mockResolvedValue(opportunity('won'));
    const won = await timeline();
    expect(won[3]).toBe('done: Quotation SentReached');
    expect(won[4]).toBe('muted: NegotiationNot recorded');
    expect(won[5]).toBe('done: WonWon');
  });

  it('marks the held stage and what led to it, with On Hold as the current step', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('on_hold', {
        heldFromStage: 'negotiation',
        stageReason: 'Budget pause',
        stageNote: 'Resume next month.',
      }),
    );
    expect(await timeline()).toEqual([
      'done: QualifiedReached',
      'muted: Requirement ReceivedNot recorded',
      'muted: Proposal SentNot recorded',
      'done: Quotation SentReached',
      'done: NegotiationReached',
      'upcoming: WonNot yet',
      'warning: On HoldCurrent',
    ]);
  });

  it('marks nothing past Qualified as reached for a hold with no recorded stage (before F1-Q53)', async () => {
    for (const heldFromStage of [null, undefined]) {
      mocks.getOpportunity.mockResolvedValue(opportunity('on_hold', { heldFromStage }));
      expect(await timeline()).toEqual([
        'done: QualifiedReached',
        'muted: Requirement ReceivedNot recorded',
        'muted: Proposal SentNot recorded',
        'muted: Quotation SentNot recorded',
        'muted: NegotiationNot recorded',
        'upcoming: WonNot yet',
        'warning: On HoldCurrent',
      ]);
    }
    // A sent quotation still proves Quotation Sent; Negotiation stays unknown.
    mocks.getOpportunity.mockResolvedValue(opportunity('on_hold', { heldFromStage: null }));
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'sent', canEdit: false })]);
    expect((await timeline()).slice(3, 5)).toEqual([
      'done: Quotation SentReached',
      'muted: NegotiationNot recorded',
    ]);
  });

  it('says plain Resume with no stage for a hold with no recorded stage, and names a recorded one', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('on_hold', { heldFromStage: null, allowedMoves: ['negotiation'] }),
    );
    let html = await render();
    let doc = parse(html);
    expect(headerStageButtons(doc)).toEqual(['Resume']);
    expect(doc.querySelector('[aria-label="Stage"]')?.textContent).toContain(
      'This opportunity is on hold. Use Resume in the header to take it off hold.',
    );
    expect(doc.body.textContent).not.toContain('Negotiation.');

    mocks.getOpportunity.mockResolvedValue(
      opportunity('on_hold', { heldFromStage: 'negotiation', allowedMoves: ['negotiation'] }),
    );
    html = await render();
    doc = parse(html);
    expect(headerStageButtons(doc)).toEqual(['Resume']);
    expect(doc.querySelector('[aria-label="Stage"]')?.textContent).toContain(
      'This opportunity is on hold. Use Resume in the header to return it to Negotiation.',
    );
  });

  it('counts a sent quotation, not a draft, as reaching Quotation Sent on a lost deal', async () => {
    mocks.getOpportunity.mockResolvedValue(opportunity('lost', { stageReason: 'Price' }));
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'sent', canEdit: false })]);
    expect(await timeline()).toEqual([
      'done: QualifiedReached',
      'muted: Requirement ReceivedNot recorded',
      'muted: Proposal SentNot recorded',
      'done: Quotation SentReached',
      'upcoming: NegotiationNot yet',
      'upcoming: WonNot yet',
      'error: LostCurrent',
    ]);
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'draft' })]);
    expect((await timeline())[3]).toBe('upcoming: Quotation SentNot yet');
  });

  it('keeps Quotation Sent reached on a lost deal whose only quotation was sent and then cancelled', async () => {
    // Losing a deal cancels its open quotations, sent ones included; the stage history still proves it.
    mocks.getOpportunity.mockResolvedValue(
      opportunity('lost', {
        stageReason: 'Price',
        stageHistory: [
          {
            from: 'qualified',
            to: 'quotation_sent',
            at: '2026-11-01T05:00:00.000Z',
            actorName: null,
          },
          { from: 'quotation_sent', to: 'lost', at: '2026-11-05T05:00:00.000Z', actorName: 'Asha' },
        ],
      }),
    );
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'cancelled', canEdit: false })]);
    expect((await timeline())[3]).toBe('done: Quotation SentReached');
    // Without that history the cancelled quotation proves nothing, as before.
    mocks.getOpportunity.mockResolvedValue(opportunity('lost', { stageReason: 'Price' }));
    expect((await timeline())[3]).toBe('upcoming: Quotation SentNot yet');
  });

  it('enforces read-only mode when canEdit is false and allowedMoves is empty', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('qualified', { allowedMoves: [], canEdit: false }),
    );
    mocks.listQuotations.mockResolvedValue([quote(Q1)]);
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(
        opts.status === 'planned'
          ? [
              {
                id: '66666666-6666-4666-8666-666666666667',
                kind: 'call',
                subject: 'Follow up on quote',
                body: null,
                leadId: null,
                opportunityId: OPP,
                customerId: null,
                contactId: null,
                quotationId: null,
                dueAt: '2099-01-02T04:00:00.000Z',
                assigneeUserId: null,
                assigneeName: null,
                completedAt: null,
                cancelledAt: null,
                planned: true,
                createdByUserId: null,
                createdByName: null,
                occurredAt: WHEN,
                version: 1,
              },
            ]
          : [],
      ),
    );

    const html = await render();
    const doc = parse(html);
    expect(headerStageButtons(doc)).toEqual([]);
    // Quotations follow quotation.draft, which the sales role holds without opportunity write access.
    expect(headerLinks(html).map(([label]) => label)).toContain('View quotations');
    expect(headerLinks(html).map(([label]) => label)).toContain('Edit quotation');
    expect(doc.querySelector('[aria-label="Stage"]')?.textContent).toContain(
      'You have read-only access to this opportunity.',
    );
    expect(html).not.toContain('Log activity');
    expect(html).not.toContain('Schedule follow-up');
    expect(html).not.toContain('aria-label="Complete Follow up on quote"');
    expect(html).not.toContain('aria-label="Reschedule Follow up on quote"');
    expect(html).not.toContain('aria-label="Cancel Follow up on quote"');
  });

  it('fails closed when canEdit and allowedMoves are omitted for a read-only role', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['management'] });
    mocks.getOpportunity.mockResolvedValue(
      opportunity('qualified', { allowedMoves: undefined, canEdit: undefined }),
    );
    const html = await render();
    const doc = parse(html);
    expect(headerStageButtons(doc)).toEqual([]);
    expect(doc.querySelector('[aria-label="Stage"]')?.textContent).toContain(
      'You have read-only access to this opportunity.',
    );
  });

  it('still shows Mark lost when the lost-reasons list fails to load', async () => {
    mocks.listOpportunityLostReasonChoices.mockRejectedValue(new Error('down'));
    const html = await render();
    expect(html).toContain('>Mark lost</button>');
  });

  it('leaves out Mark lost when the lost-reasons list is refused with 403 (read-only access)', async () => {
    mocks.listOpportunityLostReasonChoices.mockRejectedValue(new ApiError(403, 'forbidden'));
    const html = await render();
    expect(mocks.listOpportunityLostReasonChoices).toHaveBeenCalledOnce();
    expect(html).not.toContain('>Mark lost</button>');
  });

  it('shows lostReason.label over stageReason with the retired note when retired', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('lost', {
        stageReason: 'Timing',
        lostReason: { id: LOST_REASON, label: 'Bad timing', retired: true },
        stageNote: 'Deferred to next year.',
      }),
    );
    const html = await render();
    expect(html).toContain('<strong>Bad timing</strong>');
    expect(html).toContain('This reason is no longer offered for new opportunities.');
    expect(html).toContain('Deferred to next year.');
  });

  it('falls back to stageReason without the retired note when lostReason is null', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('lost', {
        stageReason: 'Budget freeze',
        lostReason: null,
        stageNote: 'Paused.',
      }),
    );
    const html = await render();
    expect(html).toContain('<strong>Budget freeze</strong>');
    expect(html).not.toContain('no longer offered');
  });
});

describe('stage history (R4a Q13)', () => {
  const historyRows = (doc: Document) =>
    [...doc.querySelectorAll('[aria-label="Stage changes"] > li')].map((li) => li.textContent);

  it('lists each recorded change oldest first: stages, who, and when, with System for a system move', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('quotation_sent', {
        stageHistory: [
          {
            from: 'qualified',
            to: 'requirement_received',
            at: '2026-11-08T05:45:00.000Z',
            actorName: 'Asha Rai',
          },
          {
            from: 'requirement_received',
            to: 'quotation_sent',
            at: '2026-11-09T06:00:00.000Z',
            actorName: null,
          },
        ],
      }),
    );
    const doc = parse(await render());
    const rows = historyRows(doc);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Qualified to Requirement Received');
    expect(rows[0]).toContain('Asha Rai');
    expect(rows[1]).toContain('Requirement Received to Quotation Sent');
    expect(rows[1]).toContain('System');
    const times = [...doc.querySelectorAll('[aria-label="Stage changes"] time')].map((t) =>
      t.getAttribute('datetime'),
    );
    expect(times).toEqual(['2026-11-08T05:45:00.000Z', '2026-11-09T06:00:00.000Z']);
    expect(doc.body.textContent).not.toContain('No stage changes recorded yet.');
    // The stage timeline is still there.
    expect(doc.querySelector('[aria-label="Opportunity stages"]')).not.toBeNull();
  });

  it('says no change is recorded yet when the history is empty or absent', async () => {
    for (const stageHistory of [[], undefined]) {
      mocks.getOpportunity.mockResolvedValue(opportunity('qualified', { stageHistory }));
      const doc = parse(await render());
      expect(historyRows(doc)).toEqual([]);
      expect(doc.body.textContent).toContain('No stage changes recorded yet.');
    }
  });
});

describe("the deal's owner (F1-Q51)", () => {
  const SITA = '66666666-6666-4666-8666-666666666661';
  const RAM = '66666666-6666-4666-8666-666666666662';
  /** `GET /v1/opportunities/owners` as the API sends it: emails always empty. */
  const owners = [
    { userId: SITA, displayName: 'Sita Rai', email: '' },
    { userId: RAM, displayName: 'Ram Thapa', email: '' },
  ];
  const ownerFact = (doc: Document) =>
    [...doc.querySelectorAll('dt')].find((dt) => dt.textContent === 'Owner')?.nextElementSibling;

  it('names the owner and offers Change owner to an editor, saying follow-ups move', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', { ownerUserId: SITA, ownerName: 'Sita Rai' }),
    );
    mocks.listOpportunityOwners.mockResolvedValue(owners);
    const fact = ownerFact(parse(await render()));
    expect(fact?.textContent).toContain('Sita Rai');
    expect(fact?.textContent).toContain('Change owner');
    expect(fact?.querySelector('input[name="ownerUserId"]')?.getAttribute('value')).toBe(SITA);
    expect(fact?.querySelector('input[name="opportunityId"]')?.getAttribute('value')).toBe(OPP);
    expect(fact?.textContent).toContain(
      "The previous owner's open follow-ups move to the new owner.",
    );
  });

  it('shows the name alone to someone who cannot edit, without asking for the owners list', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', {
        ownerUserId: SITA,
        ownerName: 'Sita Rai',
        canEdit: false,
        allowedMoves: [],
      }),
    );
    const fact = ownerFact(parse(await render()));
    expect(fact?.textContent).toContain('Sita Rai');
    expect(fact?.textContent).not.toContain('Change owner');
    expect(mocks.listOpportunityOwners).not.toHaveBeenCalled();
  });

  it('offers no hand-over on a won deal, and says No owner when there is none', async () => {
    mocks.getOpportunity.mockResolvedValue(opportunity('won'));
    mocks.listOpportunityOwners.mockResolvedValue(owners);
    const fact = ownerFact(parse(await render()));
    expect(fact?.textContent).toContain('No owner');
    expect(fact?.textContent).not.toContain('Change owner');
  });

  it('still renders the name when the owners list is refused', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('qualified', { ownerUserId: SITA, ownerName: 'Sita Rai' }),
    );
    mocks.listOpportunityOwners.mockRejectedValue(new ApiError(403, 'forbidden'));
    const fact = ownerFact(parse(await render()));
    expect(fact?.textContent).toContain('Sita Rai');
    expect(fact?.textContent).not.toContain('Change owner');
  });
});

describe('credit hold on the deal (F1-Q20)', () => {
  const held = () =>
    opportunity('won', { creditHold: { held: true, overridden: false }, number: 'DEAL-0042' });
  /** `GET /v1/opportunities/:id/credit-hold` as the API sends it. */
  const position = CreditHoldDtoSchema.parse({
    opportunityId: OPP,
    customerId: CUSTOMER,
    currency: 'NPR',
    creditLimit: '500000.00',
    exposure: '512345.50',
    uninvoiced: '0.00',
    orderValue: '0.00',
    exposureWithOrder: '512345.50',
    held: true,
    pendingQuotationVersionId: '4a8c3f0e-6b1d-4e2a-9c57-1d3e5f7a9b02',
    override: null,
    overrideCovers: false,
  });
  const grants = (...held: string[]) =>
    mocks.getPermissionCheck.mockResolvedValue((p: string) => held.includes(p));
  const metadata = (doc: Document) => doc.querySelector('h1')?.parentElement?.parentElement;
  const banner = (doc: Document) =>
    [...doc.querySelectorAll('[role="status"]')].find((el) =>
      el.textContent?.startsWith('Credit hold'),
    ) ?? null;

  it('marks the header and says who can override, with no Override button, to someone without credit.override', async () => {
    mocks.getOpportunity.mockResolvedValue(held());
    grants('crm.opportunity.read');
    const doc = parse(await render());
    expect(metadata(doc)?.textContent).toContain('Credit hold');
    expect(banner(doc)?.textContent).toContain('over its credit limit');
    expect(banner(doc)?.textContent).toContain(
      'Someone with credit override access can override the hold.',
    );
    expect(banner(doc)?.textContent).not.toMatch(/Management|Finance/);
    expect(doc.body.textContent).not.toContain('Override credit hold');
    expect(banner(doc)?.textContent).not.toMatch(/500,000|5,00,000/);
    expect(mocks.getCreditHold).not.toHaveBeenCalled();
  });

  it('shows the amounts and the Override action to a credit.override holder', async () => {
    mocks.getOpportunity.mockResolvedValue(held());
    mocks.getCreditHold.mockResolvedValue(position);
    grants('crm.opportunity.read', 'credit.override');
    const doc = parse(await render());
    expect(mocks.getCreditHold).toHaveBeenCalledWith(expect.anything(), OPP);
    const text = banner(doc)?.textContent ?? '';
    expect(text).toMatch(
      /open receivables are .*5,12,345\.50.* against a limit of .*5,00,000\.00/i,
    );
    expect(
      [...(banner(doc)?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
    ).toContain('Override credit hold');
  });

  it("names open receivables and this deal's order when the order takes the customer over the limit", async () => {
    mocks.getOpportunity.mockResolvedValue(held());
    mocks.getCreditHold.mockResolvedValue({
      ...position,
      creditLimit: '100000.00',
      exposure: '90000.00',
      orderValue: '22600.00',
      exposureWithOrder: '112600.00',
    });
    grants('crm.opportunity.read', 'credit.override');
    const text = banner(parse(await render()))?.textContent ?? '';
    expect(text).toMatch(
      /Open receivables are .*90,000\.00 and this deal's order is .*22,600\.00: .*1,12,600\.00 against a limit of .*1,00,000\.00\./,
    );
    expect(text).not.toContain('owes');
  });

  describe("names this deal's order only when it counts towards the hold", () => {
    const HELD_ALONE = 'This customer is over its credit limit';
    const WITH_ORDER = "With this deal's order, this customer is over its credit limit";

    it('says the customer alone is over the limit when the hold counts no order (orderValue 0.00)', async () => {
      mocks.getOpportunity.mockResolvedValue(held());
      mocks.getCreditHold.mockResolvedValue(position);
      grants('crm.opportunity.read', 'credit.override');
      const text = banner(parse(await render()))?.textContent ?? '';
      expect(text).toContain(HELD_ALONE);
      expect(text).not.toContain("With this deal's order");
    });

    it("names this deal's order when the hold counts it (orderValue above 0)", async () => {
      mocks.getOpportunity.mockResolvedValue(held());
      mocks.getCreditHold.mockResolvedValue({
        ...position,
        orderValue: '22600.00',
        exposureWithOrder: '534945.50',
      });
      grants('crm.opportunity.read', 'credit.override');
      const text = banner(parse(await render()))?.textContent ?? '';
      expect(text).toContain(WITH_ORDER);
      expect(text).not.toContain(HELD_ALONE);
    });

    it("names this deal's order when the amounts are unavailable (no credit.override, or the read failed)", async () => {
      mocks.getOpportunity.mockResolvedValue(held());
      grants('crm.opportunity.read');
      let text = banner(parse(await render()))?.textContent ?? '';
      expect(mocks.getCreditHold).not.toHaveBeenCalled();
      expect(text).toContain(WITH_ORDER);
      expect(text).not.toContain(HELD_ALONE);

      mocks.getCreditHold.mockRejectedValue(new ApiError(503, 'down'));
      grants('crm.opportunity.read', 'credit.override');
      text = banner(parse(await render()))?.textContent ?? '';
      expect(mocks.getCreditHold).toHaveBeenCalled();
      expect(text).toContain(WITH_ORDER);
      expect(text).not.toContain(HELD_ALONE);
    });
  });

  it('keeps the Override action when the amounts do not load', async () => {
    mocks.getOpportunity.mockResolvedValue(held());
    mocks.getCreditHold.mockRejectedValue(new ApiError(503, 'down'));
    grants('credit.override');
    const doc = parse(await render());
    expect(banner(doc)?.textContent).toContain('over its credit limit');
    expect(banner(doc)?.textContent).not.toContain('owes');
    expect(doc.body.textContent).toContain('Override credit hold');
  });

  it('flags an open deal before any quotation is accepted, in words true for it', async () => {
    mocks.getOpportunity.mockResolvedValue(
      opportunity('negotiation', { creditHold: { held: true, overridden: false, ordered: false } }),
    );
    grants('crm.opportunity.read', 'credit.override');
    mocks.getCreditHold.mockResolvedValue(position);
    const doc = parse(await render());
    expect(metadata(doc)?.textContent).toContain('Credit hold');
    const text = banner(doc)?.textContent ?? '';
    expect(text).toContain('an accepted quotation on this deal cannot become a sales order');
    expect(text).not.toContain('the accepted quotation');
    expect(doc.body.textContent).toContain('Override credit hold');
  });

  it('shows no hold and no override on a lost deal, or a won one whose sales order went ahead', async () => {
    grants('crm.opportunity.read', 'credit.override');
    for (const deal of [
      opportunity('lost', { creditHold: { held: true, overridden: false, ordered: false } }),
      opportunity('won', { creditHold: { held: true, overridden: false, ordered: true } }),
    ]) {
      mocks.getOpportunity.mockResolvedValue(deal);
      const doc = parse(await render());
      expect(metadata(doc)?.textContent).not.toContain('Credit hold');
      expect(banner(doc)).toBeNull();
      expect(doc.body.textContent).not.toContain('Override credit hold');
    }
    expect(mocks.getCreditHold).not.toHaveBeenCalled();
  });

  it('shows nothing once the hold is overridden, or when the flag is absent', async () => {
    grants('credit.override');
    mocks.getOpportunity.mockResolvedValue(
      opportunity('won', { creditHold: { held: true, overridden: true } }),
    );
    let doc = parse(await render());
    expect(metadata(doc)?.textContent).not.toContain('Credit hold');
    expect(banner(doc)).toBeNull();

    mocks.getOpportunity.mockResolvedValue(opportunity('won'));
    doc = parse(await render());
    expect(banner(doc)).toBeNull();
    expect(mocks.getCreditHold).not.toHaveBeenCalled();
  });
});

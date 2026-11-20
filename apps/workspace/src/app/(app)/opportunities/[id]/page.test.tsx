// @vitest-environment jsdom
import type { OpportunityDto, QuotationListItem } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import OpportunityPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getOpportunity: vi.fn(),
  listActivities: vi.fn(),
  listLeadOwners: vi.fn(),
  getCustomer: vi.fn(),
  listQuotations: vi.fn(),
  listOpportunityLostReasonChoices: vi.fn(),
  userNames: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-lead-lost-reasons', () => ({
  listOpportunityLostReasonChoices: mocks.listOpportunityLostReasonChoices,
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getOpportunity: mocks.getOpportunity,
  listActivities: mocks.listActivities,
  listLeadOwners: mocks.listLeadOwners,
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
vi.mock('../actions', () => ({ moveOpportunityStageAction: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
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
  mocks.getCustomer.mockReset().mockResolvedValue(null);
  mocks.listQuotations.mockReset().mockResolvedValue([]);
  mocks.listOpportunityLostReasonChoices.mockReset().mockResolvedValue([]);
  mocks.userNames.mockReset().mockResolvedValue(new Map());
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
  };

  beforeEach(() => {
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      Promise.resolve(opts.status === 'planned' ? [planned] : []),
    );
  });

  it('lists planned rows on a Follow-ups card with Complete, Reschedule and Cancel, and no Schedule', async () => {
    const html = await render();
    expect(mocks.listActivities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ opportunityId: OPP, status: 'planned' }),
    );
    expect(html).toContain('>Follow-ups</h2>');
    expect(html).toContain('Chase the signed scope');
    for (const action of ['Complete', 'Reschedule', 'Cancel']) {
      expect(html).toContain(`aria-label="${action} Chase the signed scope"`);
    }
    expect(html).not.toContain('Schedule follow-up');
  });

  it('names the assignee from the activity itself, never by id or directory', async () => {
    const html = await render();
    expect(html).toContain('Mira Thapa');
    expect(html).not.toContain('Another teammate');
    expect(html).not.toContain(`>${ASSIGNEE}<`);
  });

  it('does not ask for lead owners without crm.lead.write, and still renders', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['no-such-role'] });
    const html = await render();
    expect(mocks.listLeadOwners).not.toHaveBeenCalled();
    expect(html).toContain('Chase the signed scope');
    expect(html).toContain('Mira Thapa');
    expect(html).not.toContain('Another teammate');
  });

  it('says the follow-ups did not load instead of showing an empty card', async () => {
    mocks.listActivities.mockImplementation((_s: unknown, opts: { status?: string }) =>
      opts.status === 'planned' ? Promise.reject(new ApiError(503, 'down')) : Promise.resolve([]),
    );
    const html = await render();
    expect(html).toContain('Follow-ups did not load');
    expect(html).not.toContain('No follow-ups planned');
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
      'This opportunity is on hold. Use Resume in the header to return it to Negotiation.',
    ],
    ['lost', [] as OpportunityDto['stage'][], [], 'Only a manager can reopen a lost opportunity.'],
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

  it('renders timeline done, current, upcoming, warning (on_hold) and error (lost) tones', async () => {
    // Linear stage: quotation_sent
    mocks.getOpportunity.mockResolvedValue(opportunity('quotation_sent'));
    const linearDoc = parse(await render());
    const linearSteps = [...linearDoc.querySelectorAll('[aria-label="Opportunity stages"] > li')];
    expect(linearSteps.map((li) => li.className)).toEqual([
      expect.stringContaining('done'),
      expect.stringContaining('done'),
      expect.stringContaining('done'),
      expect.stringContaining('current'),
      expect.stringContaining('upcoming'),
      expect.stringContaining('upcoming'),
    ]);
    expect(linearSteps[0]?.textContent).toContain('Reached');
    expect(linearSteps[3]?.textContent).toContain('Current');
    expect(linearSteps[4]?.textContent).toContain('Not yet');

    // Won: all linear steps done, final status Won
    mocks.getOpportunity.mockResolvedValue(opportunity('won'));
    const wonDoc = parse(await render());
    const wonSteps = [...wonDoc.querySelectorAll('[aria-label="Opportunity stages"] > li')];
    expect(wonSteps.every((li) => li.className.includes('done'))).toBe(true);
    expect(wonSteps[5]?.textContent).toContain('Won');

    // On hold: qualified..negotiation done, won upcoming, On Hold warning
    mocks.getOpportunity.mockResolvedValue(
      opportunity('on_hold', { stageReason: 'Budget pause', stageNote: 'Resume next month.' }),
    );
    const holdDoc = parse(await render());
    const holdSteps = [...holdDoc.querySelectorAll('[aria-label="Opportunity stages"] > li')];
    expect(holdSteps.map((li) => li.className)).toEqual([
      expect.stringContaining('done'),
      expect.stringContaining('done'),
      expect.stringContaining('done'),
      expect.stringContaining('done'),
      expect.stringContaining('done'),
      expect.stringContaining('upcoming'),
      expect.stringContaining('warning'),
    ]);
    expect(holdSteps[6]?.textContent).toContain('On Hold');
    expect(holdSteps[6]?.textContent).toContain('Current');

    // Lost with a quotation: qualified and quotation_sent done, Lost error
    mocks.getOpportunity.mockResolvedValue(opportunity('lost', { stageReason: 'Price' }));
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'sent', canEdit: false })]);
    const lostDoc = parse(await render());
    const lostSteps = [...lostDoc.querySelectorAll('[aria-label="Opportunity stages"] > li')];
    expect(lostSteps.map((li) => li.className)).toEqual([
      expect.stringContaining('done'),
      expect.stringContaining('upcoming'),
      expect.stringContaining('upcoming'),
      expect.stringContaining('done'),
      expect.stringContaining('upcoming'),
      expect.stringContaining('upcoming'),
      expect.stringContaining('error'),
    ]);
    expect(lostSteps[6]?.textContent).toContain('Lost');
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
    expect(headerLinks(html)).toEqual([['View quotations', `/quotations?opportunityId=${OPP}`]]);
    expect(doc.querySelector('[aria-label="Stage"]')?.textContent).toContain(
      'You have read-only access to this opportunity.',
    );
    expect(html).not.toContain('Add activity');
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

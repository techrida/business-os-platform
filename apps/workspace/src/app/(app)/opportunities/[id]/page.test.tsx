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
  moveForm: vi.fn(),
  userNames: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-lead-lost-reasons', () => ({
  listOpportunityLostReasonChoices: mocks.listOpportunityLostReasonChoices,
}));
vi.mock('@/components/p2/crm/move-form', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/p2/crm/move-form')>();
  return {
    ...actual,
    MoveForm: (props: Parameters<typeof actual.MoveForm>[0]) => {
      mocks.moveForm(props);
      return actual.MoveForm(props);
    },
  };
});
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

/** Every link-button in the page header, as [label, href]. */
function headerLinks(html: string): [string, string][] {
  return [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .map((m) => [m[2] ?? '', (m[1] ?? '').replaceAll('&amp;', '&')] as [string, string])
    .filter(([label]) => /quotation|draft/i.test(label));
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.getOpportunity.mockReset().mockResolvedValue(opportunity());
  mocks.listActivities.mockReset().mockResolvedValue([]);
  mocks.listLeadOwners.mockReset().mockResolvedValue([]);
  mocks.getCustomer.mockReset().mockResolvedValue(null);
  mocks.listQuotations.mockReset().mockResolvedValue([]);
  mocks.listOpportunityLostReasonChoices.mockReset().mockResolvedValue([]);
  mocks.moveForm.mockReset();
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

describe('opportunity Mark lost and lost reason display (D54-3)', () => {
  const LOST_REASON = '88888888-8888-4888-8888-888888888888';

  it.each([
    ['qualified', true],
    ['requirement_received', true],
    ['proposal_sent', true],
    ['quotation_sent', true],
    ['negotiation', true],
    ['on_hold', false],
    ['lost', false],
    ['won', false],
  ] as const)(
    'shows Mark lost and reads choices only when the %s stage allows moving to lost',
    async (stage, allowed) => {
      mocks.getOpportunity.mockResolvedValue(opportunity(stage));
      const html = await render();
      if (allowed) {
        expect(html).toContain('>Mark lost</button>');
        expect(mocks.listOpportunityLostReasonChoices).toHaveBeenCalledOnce();
      } else {
        expect(html).not.toContain('>Mark lost</button>');
        expect(mocks.listOpportunityLostReasonChoices).not.toHaveBeenCalled();
      }
    },
  );

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

  it('does not promise a reopen on a lost opportunity, which the API refuses for every caller', async () => {
    mocks.getOpportunity.mockResolvedValue(opportunity('lost', { stageReason: 'Timing' }));
    const html = await render();
    expect(html).toContain('No further moves from here.');
    expect(html).not.toContain('reopen');
  });

  it('excludes lost from MoveForm so Lost is only reached through the Mark lost dialog', async () => {
    mocks.getOpportunity.mockResolvedValue(opportunity('qualified'));
    await render();
    const call = mocks.moveForm.mock.calls.at(-1)?.[0] as
      { moves: { stage: string }[]; exclude?: readonly string[] } | undefined;
    expect(call?.exclude).toContain('lost');
    const offered = (call?.moves ?? []).filter((m) => !(call?.exclude ?? []).includes(m.stage));
    expect(offered.map((m) => m.stage)).not.toContain('lost');
  });
});

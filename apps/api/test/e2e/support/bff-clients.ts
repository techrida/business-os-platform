// Loads the workspace BFF's REAL API clients (apps/workspace/src/components/p2/**/ *api.ts, and the P3 ones:
// lib/api-billing.ts, lib/api-receivables.ts, the staff proof upload) and the portal's billing client
// (apps/portal/src/lib/api.billing.ts) inside the API's e2e run, so a contract test can call them against the
// real, listening API.
//
// What runs for real: the client functions, their request building (path, query, method, headers, body),
// the workspace's and portal's `apiFetch` (bearer token, x-request-id) and every zod schema the clients parse
// with. What is replaced: `server-only` (it throws outside a React server build) and `getEnv()` (the
// workspace and portal envs need the whole auth stack; the clients only read `API_INTERNAL_URL` from it).
// One more stub: api-billing imports `nextKey` from the CRM idempotency helper, whose import chain reaches the
// session store and `next/headers`. Only `keyAfterFailure` (the retry-key rule) uses it, and no call here
// goes through it.
//
// Why the odd loading: the workspace modules import through the `@/` alias, which this package's tsconfig
// does not have (the e2e Vitest config maps it to apps/workspace/src), and `tsc -p apps/api` type-checks test/. A literal `import()` would make
// tsc follow into workspace files and fail on `@/lib/api`. The paths therefore live in variables, and the
// client shapes are declared here from `@bos/contracts` types (signatures only; the schemas stay in the
// clients, which is the point). If a client signature changes, the call in the test stops type-checking.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type {
  ActivityDto,
  ActivityKind,
  AllocatePaymentBody,
  AllocationDto,
  ArAgingReport,
  AttachVerificationDocumentBody,
  ConfirmSalesOrderBody,
  ContactDto,
  ConvertLeadBody,
  CreateActivityBody,
  CreateLeadBody,
  CreateManualInvoiceBody,
  CreateQuotationBody,
  CreditNoteBody,
  CustomerAdvance,
  CustomerDto,
  CustomerInvoiceView,
  DebitNoteBody,
  DiscardInvoiceBody,
  DraftFromScheduleBody,
  InvoiceDetail,
  InvoiceKind,
  InvoiceListItem,
  InvoiceSettlement,
  InvoiceStatus,
  IssueInvoiceBody,
  IssueInvoiceResult,
  LeadDto,
  LeadStageChangeBody,
  MarkBillableBody,
  OpportunityDto,
  OpportunityStageChangeBody,
  PartyAccountDto,
  PaymentDto,
  PaymentListItem,
  PaymentStatus,
  PaymentTerm,
  PortalInvoiceListItem,
  PortalPaymentListItem,
  PortalSubmitPaymentBody,
  PreviewResult,
  QuotationDetail,
  QuotationDto,
  QuotationListItem,
  QuotationPreviewBody,
  QuotationStatus,
  SalesOrderDetail,
  SalesOrderListItem,
  SalesOrderStatus,
  SignedLinkDto,
  SubmitInvoiceBody,
  SubmitPaymentBody,
  TaxCode,
  UpdateQuotationDraftBody,
  VerificationCaseDto,
  VerificationStatus,
  VerifyPaymentBody,
} from '@bos/contracts';
import { vi } from 'vitest';

/** The only field of the workspace `Session` that `apiFetch` reads. */
export interface BffSession {
  accessToken: string;
}
type S = BffSession;

export interface Listing<T> {
  items: T[];
  total: number | null;
}
// The workspace's CustomerDetailSchema keeps these beside the contract CustomerDto; the test only checks they arrive.
export type CustomerDetail = CustomerDto & {
  accounts?: PartyAccountDto[] | undefined;
  people?: unknown;
  can?: unknown;
  verification?: unknown;
  portalAccess?: unknown;
};

/** components/p2/crm/crm-api.ts */
export interface CrmClient {
  listLeads(s: S, opts?: { stage?: string; q?: string; limit?: number }): Promise<LeadDto[]>;
  getLead(s: S, id: string): Promise<LeadDto>;
  createLead(s: S, body: CreateLeadBody, idempotencyKey: string): Promise<LeadDto>;
  changeLeadStage(s: S, id: string, body: LeadStageChangeBody): Promise<LeadDto>;
  convertLead(
    s: S,
    id: string,
    body: ConvertLeadBody,
    idempotencyKey: string,
  ): Promise<{ opportunityId: string; customerId?: string | undefined }>;
  listOpportunities(
    s: S,
    opts?: { stage?: string; q?: string; limit?: number },
  ): Promise<OpportunityDto[]>;
  getOpportunity(s: S, id: string): Promise<OpportunityDto>;
  changeOpportunityStage(
    s: S,
    id: string,
    body: OpportunityStageChangeBody,
  ): Promise<OpportunityDto>;
  listActivities(
    s: S,
    opts?: { leadId?: string; opportunityId?: string; kind?: ActivityKind; limit?: number },
  ): Promise<ActivityDto[]>;
  createActivity(s: S, body: CreateActivityBody, idempotencyKey: string): Promise<ActivityDto>;
}

/** components/p2/crm/verification-api.ts */
export interface VerificationClient {
  openVerificationCase(s: S, partyId: string, idempotencyKey: string): Promise<VerificationCaseDto>;
  attachChecklistDocument(
    s: S,
    caseId: string,
    body: AttachVerificationDocumentBody,
    idempotencyKey: string,
  ): Promise<VerificationCaseDto>;
  submitVerificationCase(
    s: S,
    caseId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<VerificationCaseDto>;
  getDocument(
    s: S,
    documentId: string,
  ): Promise<{ id: string; currentVersionId: string | null; versions: unknown[] }>;
}

/** components/p2/customers/api.ts (the reads the CRM and KYB screens use). */
export interface CustomersClient {
  listCustomers(
    s: S,
    query: { q?: string; limit?: number; offset?: number },
  ): Promise<Listing<CustomerDto>>;
  getCustomer(s: S, id: string): Promise<CustomerDto>;
  getCustomerDetail(s: S, id: string): Promise<CustomerDetail>;
  listContacts(s: S, customerId: string): Promise<Listing<ContactDto>>;
  listVerificationCases(
    s: S,
    query: { status?: VerificationStatus; partyId?: string },
  ): Promise<Listing<VerificationCaseDto>>;
  getVerificationCase(s: S, id: string): Promise<VerificationCaseDto>;
}

/** components/p2/quote-builder/api.ts */
export interface BuilderClient {
  createQuotation(s: S, body: CreateQuotationBody, idempotencyKey: string): Promise<QuotationDto>;
  updateDraft(
    s: S,
    quotationId: string,
    versionId: string,
    body: UpdateQuotationDraftBody,
  ): Promise<{ version: number }>;
  previewVersion(
    s: S,
    quotationId: string,
    versionId: string,
    body: QuotationPreviewBody,
  ): Promise<PreviewResult>;
  submitVersion(
    s: S,
    quotationId: string,
    versionId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<unknown>;
  getOpportunity(s: S, id: string): Promise<OpportunityDto>;
  getCustomer(s: S, id: string): Promise<CustomerDto>;
  listContacts(s: S, customerId: string): Promise<ContactDto[]>;
  listPaymentTerms(s: S): Promise<PaymentTerm[]>;
}

/** lib/api-tax-codes.ts (shared by quotation, sourcing and bill entry). */
export interface TaxCodesClient {
  listTaxCodes(s: S): Promise<TaxCode[]>;
}

/** components/p2/quotations/api.ts */
export interface QuotationsClient {
  listQuotations(
    s: S,
    filter?: { status?: QuotationStatus; opportunityId?: string },
  ): Promise<QuotationListItem[]>;
  getQuotation(s: S, id: string): Promise<QuotationDetail>;
}

/** lib/api-billing.ts (P3: sales orders and invoices). */
export interface BillingClient {
  listSalesOrders(
    s: S,
    filter?: { status?: SalesOrderStatus | undefined; customerId?: string | undefined },
  ): Promise<SalesOrderListItem[]>;
  getSalesOrder(s: S, id: string): Promise<SalesOrderDetail>;
  listInvoices(
    s: S,
    filter?: {
      kind?: InvoiceKind | undefined;
      status?: InvoiceStatus | undefined;
      customerId?: string | undefined;
    },
  ): Promise<InvoiceListItem[]>;
  getInvoice(s: S, id: string): Promise<InvoiceDetail>;
  invoiceDocumentPath(id: string): string;
  confirmSalesOrder(s: S, body: ConfirmSalesOrderBody, key: string): Promise<SalesOrderDetail>;
  markScheduleLineBillable(
    s: S,
    salesOrderId: string,
    scheduleLineId: string,
    body: MarkBillableBody,
    key: string,
  ): Promise<unknown>;
  draftInvoiceFromSchedule(s: S, body: DraftFromScheduleBody, key: string): Promise<InvoiceDetail>;
  createManualInvoice(s: S, body: CreateManualInvoiceBody, key: string): Promise<InvoiceDetail>;
  submitInvoice(s: S, id: string, body: SubmitInvoiceBody, key: string): Promise<unknown>;
  discardInvoice(s: S, id: string, body: DiscardInvoiceBody, key: string): Promise<unknown>;
  issueInvoice(s: S, id: string, body: IssueInvoiceBody, key: string): Promise<IssueInvoiceResult>;
  createCreditNote(s: S, body: CreditNoteBody, key: string): Promise<InvoiceDetail>;
  createDebitNote(s: S, body: DebitNoteBody, key: string): Promise<InvoiceDetail>;
}

/** lib/api-receivables.ts (P3: payments and the receivables ledger). */
export interface ReceivablesClient {
  listPayments(s: S, status?: PaymentStatus): Promise<PaymentListItem[]>;
  getPayment(s: S, id: string): Promise<PaymentDto>;
  listPaymentAllocations(s: S, id: string): Promise<AllocationDto[]>;
  submitPayment(s: S, body: SubmitPaymentBody, key: string): Promise<PaymentDto>;
  verifyPayment(s: S, id: string, body: VerifyPaymentBody, key: string): Promise<PaymentDto>;
  allocatePayment(
    s: S,
    id: string,
    body: AllocatePaymentBody,
    key: string,
  ): Promise<AllocationDto[]>;
  getAging(s: S): Promise<ArAgingReport>;
  getCustomerStatement(
    s: S,
    customerId: string,
    filter?: { openOnly?: boolean; currency?: string },
  ): Promise<InvoiceSettlement[]>;
  getCustomerAdvance(s: S, customerId: string): Promise<CustomerAdvance[]>;
}

/** app/(app)/payments/proofs/proof-upload.ts: the staff bank-slip upload (two requests: declare, then PUT). */
export interface StaffProofClient {
  uploadStaffPaymentProof(
    s: S,
    file: {
      customerId: string;
      filename: string;
      mime: string;
      size: number;
      body: ReadableStream<Uint8Array>;
    },
  ): Promise<string>;
}

/** The fields of an invoice's settlement the portal reads (its `PortalSettlementSchema` is a `.pick()`). */
export type PortalSettlement = Pick<
  InvoiceSettlement,
  'invoiceId' | 'currency' | 'total' | 'openAmount' | 'dueDate' | 'daysOverdue' | 'settlement'
>;

/** apps/portal/src/lib/api.billing.ts: the customer's invoices, settlement, payments and proof upload. */
export interface PortalBillingClient {
  listPortalInvoices(s: S): Promise<PortalInvoiceListItem[]>;
  getPortalInvoice(s: S, id: string): Promise<CustomerInvoiceView>;
  getPortalInvoiceSettlement(s: S, id: string): Promise<PortalSettlement>;
  getPortalInvoiceLink(s: S, id: string): Promise<SignedLinkDto>;
  listPortalPayments(s: S): Promise<PortalPaymentListItem[]>;
  uploadPaymentProof(
    s: S,
    file: { filename: string; mime: string; size: number; body: ReadableStream<Uint8Array> },
  ): Promise<string>;
  submitPortalPayment(s: S, body: PortalSubmitPaymentBody, idempotencyKey: string): Promise<void>;
}

type ApiErrorClass = new (
  status: number,
  message: string,
  body?: unknown,
) => Error & {
  status: number;
  body?: unknown;
};

export interface BffClients {
  crm: CrmClient;
  verification: VerificationClient;
  customers: CustomersClient;
  builder: BuilderClient;
  taxCodes: TaxCodesClient;
  quotations: QuotationsClient;
  billing: BillingClient;
  receivables: ReceivablesClient;
  staffProofs: StaffProofClient;
  portalBilling: PortalBillingClient;
  /** The workspace's own error class, so a test can assert what the screens would see. */
  ApiError: ApiErrorClass;
  /** The portal's own error class (a separate copy of the workspace one). */
  PortalApiError: ApiErrorClass;
}

// apps/api/test/e2e/support -> apps/workspace/src (four levels up to apps/).
const WS = '../../../../workspace/src';
const PORTAL = '../../../../portal/src';
// Dynamic imports with @vite-ignore resolve a relative specifier against the Vite root, not this file,
// so every import below goes through an absolute file path.
const wsUrl = (rel: string): string => fileURLToPath(new URL(`${WS}/${rel}`, import.meta.url));
const portalUrl = (rel: string): string =>
  fileURLToPath(new URL(`${PORTAL}/${rel}`, import.meta.url));

/**
 * Wires the mocks and imports the clients. Call once from `beforeAll`, after the API is listening.
 * `apiBaseUrl` is read at call time, so it may be set after this returns.
 */
export async function loadBffClients(apiBaseUrl: () => string): Promise<BffClients> {
  const apiModule = fileURLToPath(new URL(`${WS}/lib/api.ts`, import.meta.url));
  // `server-only` resolves from the workspace's node_modules, not from this package's: the mock must
  // be registered under the path the workspace file resolves to, as well as under the bare name.
  const serverOnly = createRequire(apiModule).resolve('server-only');
  vi.doMock(serverOnly, () => ({}));
  vi.doMock('server-only', () => ({}));
  // The real `apiFetch` reads its base URL through `getEnv()`.
  vi.doMock(apiModule.replace(/api\.ts$/, 'env.ts'), () => ({
    getEnv: () => ({ API_INTERNAL_URL: apiBaseUrl() }),
    __resetEnvForTests: () => undefined,
  }));

  // Load the shared error class once before importing clients. Concurrent imports through
  // aliases and absolute Windows paths can otherwise create distinct ApiError constructors.
  const api = (await import(/* @vite-ignore */ apiModule)) as Pick<BffClients, 'ApiError'>;
  vi.doMock('@/lib/api', () => api);

  // api-billing.ts imports two more `@/` modules. The failure words are pure, so the real file is used. The
  // CRM idempotency helper reaches the session store, so only its `nextKey` is stubbed (no call here uses it).
  vi.doMock(
    '@/components/p2/quote-builder/failure',
    async () =>
      (await import(/* @vite-ignore */ wsUrl('components/p2/quote-builder/failure.ts'))) as object,
  );
  vi.doMock('@/components/p2/crm/idempotency', () => ({
    nextKey: (_error: unknown, key: string): string => key,
  }));

  // The portal has its own `lib/api.ts` and `lib/env.ts`, and resolves `server-only` from its own tree.
  const portalApiModule = portalUrl('lib/api.ts');
  vi.doMock(createRequire(portalApiModule).resolve('server-only'), () => ({}));
  vi.doMock(portalApiModule.replace(/api\.ts$/, 'env.ts'), () => ({
    getEnv: () => ({ API_INTERNAL_URL: apiBaseUrl() }),
    __resetEnvForTests: () => undefined,
  }));

  const load = async <T>(rel: string): Promise<T> =>
    (await import(/* @vite-ignore */ wsUrl(rel))) as T;
  const loadPortal = async <T>(rel: string): Promise<T> =>
    (await import(/* @vite-ignore */ portalUrl(rel))) as T;
  const [
    crm,
    verification,
    customers,
    builder,
    taxCodes,
    quotations,
    billing,
    receivables,
    staffProofs,
    portalBilling,
    portalApi,
  ] = await Promise.all([
    load<CrmClient>('components/p2/crm/crm-api.ts'),
    load<VerificationClient>('components/p2/crm/verification-api.ts'),
    load<CustomersClient>('components/p2/customers/api.ts'),
    load<BuilderClient>('components/p2/quote-builder/api.ts'),
    load<TaxCodesClient>('lib/api-tax-codes.ts'),
    load<QuotationsClient>('components/p2/quotations/api.ts'),
    load<BillingClient>('lib/api-billing.ts'),
    load<ReceivablesClient>('lib/api-receivables.ts'),
    load<StaffProofClient>('app/(app)/payments/proofs/proof-upload.ts'),
    loadPortal<PortalBillingClient>('lib/api.billing.ts'),
    loadPortal<Pick<BffClients, 'ApiError'>>('lib/api.ts'),
  ]);
  return {
    crm,
    verification,
    customers,
    builder,
    taxCodes,
    quotations,
    billing,
    receivables,
    staffProofs,
    portalBilling,
    ApiError: api.ApiError,
    PortalApiError: portalApi.ApiError,
  };
}

// ------------------------------------------------------------------------------------------------ tee

export interface Exchange {
  method: string;
  path: string;
  status: number;
  /** The response body exactly as the API sent it (JSON), before any client schema touched it. */
  raw: unknown;
}

export interface FetchTee {
  /**
   * Runs `fn` (one client call) and returns its value with the raw body of the single HTTP exchange it
   * made. Fails if the call made no request or more than one, so `raw` always belongs to `value`.
   */
  through<T>(fn: () => Promise<T>): Promise<{ value: T; raw: unknown; exchange: Exchange }>;
  restore(): void;
}

/**
 * Wraps the global `fetch` the workspace `apiFetch` uses and keeps a copy of each JSON response body.
 * A zod object strips unknown keys, so a client schema that lacks a field the API sends parses fine
 * and the field silently vanishes; only the raw body can show that. Writes are never repeated: the raw
 * body comes from the same response the client parsed.
 */
export function teeFetch(apiBaseUrl?: () => string): FetchTee {
  const real = globalThis.fetch;
  const log: Exchange[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // With the worker running in this process, other code uses `fetch` too (the PDF render calls Gotenberg).
      // Only the API's own traffic belongs to a client call, so only that is kept.
      if (apiBaseUrl !== undefined && url.origin !== new URL(apiBaseUrl()).origin) {
        return real(input, init);
      }
      const res = await real(input, init);
      const text = await res.clone().text();
      let raw: unknown = text === '' ? undefined : text;
      try {
        if (text !== '') raw = JSON.parse(text) as unknown;
      } catch {
        // Not JSON: keep the text.
      }
      log.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        status: res.status,
        raw,
      });
      return res;
    });
  return {
    async through(fn) {
      const before = log.length;
      const value = await fn();
      const made = log.slice(before);
      if (made.length !== 1) {
        throw new Error(`expected one HTTP exchange from the client call, saw ${made.length}`);
      }
      const exchange = made[0]!;
      return { value, raw: exchange.raw, exchange };
    },
    restore: () => spy.mockRestore(),
  };
}

// ------------------------------------------------------------------------------------------ key audit

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every key (at any depth) the API sent that the client's parsed value no longer has. Compared only
 * where both sides have the same shape (object against object, array against array), so a schema that
 * deliberately reshapes a value (a transform) is not reported, only a dropped field is.
 * `allowed` lists key paths a client drops on purpose, written like `accounts` or `lines[].foo`;
 * a list's rows are `[]`, so a dropped field of a list row is `[].foo`.
 */
export function droppedKeys(
  raw: unknown,
  parsed: unknown,
  allowed: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const walk = (r: unknown, p: unknown, path: string): void => {
    if (Array.isArray(r) && Array.isArray(p)) {
      r.forEach((item, i) => walk(item, p[i], `${path}[]`));
    } else if (isObject(r) && isObject(p)) {
      for (const key of Object.keys(r)) {
        const here = path === '' ? key : `${path}.${key}`;
        if (!(key in p)) {
          if (!allowed.includes(here)) out.push(here);
        } else walk(r[key], p[key], here);
      }
    }
  };
  walk(raw, parsed, '');
  return [...new Set(out)];
}

/** The list the client returned, whether it is a bare array or a `{ items }` listing. */
export function rowsOf(parsed: unknown): unknown {
  return isObject(parsed) && Array.isArray(parsed.items) ? parsed.items : parsed;
}

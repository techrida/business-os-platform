// Loads the workspace BFF's REAL API clients (apps/workspace/src/components/p2/**/ *api.ts) inside the
// API's e2e run, so a contract test can call them against the real, listening API.
//
// What runs for real: the client functions, their request building (path, query, method, headers, body),
// the workspace's `apiFetch` (bearer token, x-request-id) and every zod schema the clients parse with.
// What is replaced: `server-only` (it throws outside a React server build) and `getEnv()` (the workspace
// env needs the whole auth stack; the clients only read `API_INTERNAL_URL` from it).
//
// Why the odd loading: the workspace modules import through the `@/` alias, which this package's tsconfig
// and Vitest config do not have, and `tsc -p apps/api` type-checks test/. A literal `import()` would make
// tsc follow into workspace files and fail on `@/lib/api`. The paths therefore live in variables, and the
// client shapes are declared here from `@bos/contracts` types (signatures only; the schemas stay in the
// clients, which is the point). If a client signature changes, the call in the test stops type-checking.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type {
  ActivityDto,
  ActivityKind,
  AttachVerificationDocumentBody,
  ContactDto,
  ConvertLeadBody,
  CreateActivityBody,
  CreateLeadBody,
  CreateQuotationBody,
  CustomerDto,
  LeadDto,
  LeadStageChangeBody,
  OpportunityDto,
  OpportunityStageChangeBody,
  PartyAccountDto,
  PaymentTerm,
  PreviewResult,
  QuotationDetail,
  QuotationDto,
  QuotationListItem,
  QuotationPreviewBody,
  QuotationStatus,
  TaxCode,
  UpdateQuotationDraftBody,
  VerificationCaseDto,
  VerificationStatus,
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
export type CustomerDetail = CustomerDto & { accounts?: PartyAccountDto[] | undefined };

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
  listTaxCodes(s: S): Promise<TaxCode[]>;
  listPaymentTerms(s: S): Promise<PaymentTerm[]>;
}

/** components/p2/quotations/api.ts */
export interface QuotationsClient {
  listQuotations(
    s: S,
    filter?: { status?: QuotationStatus; opportunityId?: string },
  ): Promise<QuotationListItem[]>;
  getQuotation(s: S, id: string): Promise<QuotationDetail>;
}

export interface BffClients {
  crm: CrmClient;
  verification: VerificationClient;
  customers: CustomersClient;
  builder: BuilderClient;
  quotations: QuotationsClient;
  /** The workspace's own error class, so a test can assert what the screens would see. */
  ApiError: new (
    status: number,
    message: string,
    body?: unknown,
  ) => Error & {
    status: number;
    body?: unknown;
  };
}

// apps/api/test/e2e/support -> apps/workspace/src (four levels up to apps/).
const WS = '../../../../workspace/src';
// Dynamic imports with @vite-ignore resolve a relative specifier against the Vite root, not this file,
// so every import below goes through an absolute file path.
const wsUrl = (rel: string): string => fileURLToPath(new URL(`${WS}/${rel}`, import.meta.url));

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
  // The clients import `@/lib/api`; point that alias at the real file.
  vi.doMock(
    '@/lib/api',
    async () => (await import(/* @vite-ignore */ wsUrl('lib/api.ts'))) as object,
  );
  // The real `apiFetch` reads its base URL through `getEnv()`.
  vi.doMock(apiModule.replace(/api\.ts$/, 'env.ts'), () => ({
    getEnv: () => ({ API_INTERNAL_URL: apiBaseUrl() }),
    __resetEnvForTests: () => undefined,
  }));

  const load = async <T>(rel: string): Promise<T> =>
    (await import(/* @vite-ignore */ wsUrl(rel))) as T;
  const [crm, verification, customers, builder, quotations, api] = await Promise.all([
    load<CrmClient>('components/p2/crm/crm-api.ts'),
    load<VerificationClient>('components/p2/crm/verification-api.ts'),
    load<CustomersClient>('components/p2/customers/api.ts'),
    load<BuilderClient>('components/p2/quote-builder/api.ts'),
    load<QuotationsClient>('components/p2/quotations/api.ts'),
    load<Pick<BffClients, 'ApiError'>>('lib/api.ts'),
  ]);
  return { crm, verification, customers, builder, quotations, ApiError: api.ApiError };
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
export function teeFetch(): FetchTee {
  const real = globalThis.fetch;
  const log: Exchange[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const res = await real(input, init);
      const text = await res.clone().text();
      let raw: unknown = text === '' ? undefined : text;
      try {
        if (text !== '') raw = JSON.parse(text) as unknown;
      } catch {
        // Not JSON: keep the text.
      }
      const url = new URL(input instanceof Request ? input.url : String(input));
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

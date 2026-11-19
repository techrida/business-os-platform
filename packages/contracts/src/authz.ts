// Permission vocabulary shared by the API (enforcement) and the workspace (what to show).
// Serves the NFR "authorization is deny-by-default": a route needs one of these strings or it is refused.
import { z } from 'zod';

export const PERMISSIONS = [
  'admin.users.read',
  'admin.users.invite',
  'admin.roles.read',
  'admin.roles.write',
  'admin.settings.write',
  'approvals.definitions.read',
  'approvals.definitions.write',
  'approvals.groups.write',
  'approvals.delegations.write',
  'approvals.requests.read',
  'approvals.requests.act',
  'approvals.requests.reroute',
  'documents.upload',
  'documents.read',
  'audit.read',
  'memo.create',
  'memo.read',
  'memo.update',
  // P2 sales: CRM, customers, quotations and customer verification (KYB).
  'crm.lead.read',
  'crm.lead.write',
  'crm.opportunity.read',
  'crm.opportunity.write',
  'customer.read',
  'customer.write',
  'customer.merge',
  'quotation.read',
  'quotation.draft',
  'quotation.submit',
  'quotation.send',
  'quotation.record_acceptance',
  'quotation.revise',
  'verification.read',
  'verification.review',
  // Customer portal: a customer user reads and answers their own company's quotations.
  'portal.quotation.read',
  'portal.quotation.respond',
  // P3 sales and invoicing: sales orders, invoices, payments and receivables.
  'sales_order.read',
  'sales_order.confirm',
  'sales_order.mark_billable',
  'invoice.read',
  'invoice.draft',
  'invoice.submit',
  'invoice.issue',
  'invoice.credit_note',
  'payment.read',
  'payment.record',
  'payment.verify',
  'payment.allocate',
  'ar.read',
  // Customer portal: a customer user reads their own issued invoices and submits proof of payment.
  'portal.invoice.read',
  'portal.payment.submit',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

/** How far a grant reaches: the user's own records, their department, their customer org, or everything. */
export const SCOPES = ['own', 'department', 'customer_org', 'all'] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const ROLE_KEYS = [
  'founder',
  'management',
  'finance',
  'accountant',
  'sales',
  'customer_user',
  'vendor_user',
  'pmo',
  'operations_head',
  'procurement',
  'receiver',
] as const;
export const RoleKeySchema = z.enum(ROLE_KEYS);
export type RoleKey = z.infer<typeof RoleKeySchema>;

type RoleGrants = Partial<Record<Permission, Scope>>;

/** Founder gets everything at scope `all`; built from PERMISSIONS so a new permission cannot be forgotten. */
const founderGrants: RoleGrants = Object.fromEntries(PERMISSIONS.map((p) => [p, 'all' as const]));

/** Approvers read and act on every request, and read every memo and document. */
const approverGrants: RoleGrants = {
  'approvals.requests.read': 'all',
  'approvals.requests.act': 'all',
  'memo.read': 'all',
  'documents.read': 'all',
};

/** Read every CRM, customer, quotation and verification record. Reading is not changing: no write, send or review. */
const salesReadAllGrants: RoleGrants = {
  'crm.lead.read': 'all',
  'crm.opportunity.read': 'all',
  'customer.read': 'all',
  'quotation.read': 'all',
  'verification.read': 'all',
};

/**
 * Creator roles (A2 R1 and C14): they start leads and draft and submit their own quotations. Approving is
 * the workflow's job (an approvals step), so none of these grants approve, send or record acceptance.
 */
const salesCreatorGrants: RoleGrants = {
  'crm.lead.write': 'own',
  'quotation.draft': 'own',
  'quotation.submit': 'own',
};

// --- P3 sales and invoicing grants (a separate block, so the merge with P4 stays small) ---

/** Read every sales order, invoice, payment and the receivables aging. Reading is not changing. */
const billingReadAllGrants: RoleGrants = {
  'sales_order.read': 'all',
  'invoice.read': 'all',
  'payment.read': 'all',
  'ar.read': 'all',
};

/**
 * The Accountant prepares the money documents: confirms orders, marks schedule lines billable, drafts
 * and submits invoices, and records and allocates payments. The Accountant does not issue, credit or
 * verify: those are Finance (maker-checker, and the verifier must differ from the recorder).
 */
const billingPreparerGrants: RoleGrants = {
  'sales_order.confirm': 'all',
  'sales_order.mark_billable': 'all',
  'invoice.draft': 'all',
  'invoice.submit': 'all',
  'payment.record': 'all',
  'payment.allocate': 'all',
};

/** Finance holds the checker powers: issue an approved invoice, issue a credit or debit note, verify a payment. */
const billingFinanceGrants: RoleGrants = {
  'invoice.issue': 'all',
  'invoice.credit_note': 'all',
  'payment.verify': 'all',
};

/** What every internal user who is not an approver may do in the kernel: their own memos, documents and requests. */
const staffBaseGrants: RoleGrants = {
  'memo.create': 'own',
  'memo.update': 'own',
  'memo.read': 'own',
  'documents.upload': 'own',
  'documents.read': 'own',
  'approvals.requests.read': 'own',
};

/**
 * What each role may do before an admin edits `app.role_permissions`. The seed copies this into
 * the table, so the table (not this constant) is the live truth at runtime.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, RoleGrants> = {
  founder: founderGrants,
  management: { ...approverGrants, ...salesReadAllGrants, ...billingReadAllGrants },
  finance: {
    ...approverGrants,
    'audit.read': 'all',
    ...salesReadAllGrants,
    ...salesCreatorGrants,
    ...billingReadAllGrants,
    ...billingPreparerGrants,
    ...billingFinanceGrants,
  },
  accountant: {
    ...approverGrants,
    ...salesReadAllGrants,
    ...salesCreatorGrants,
    ...billingReadAllGrants,
    ...billingPreparerGrants,
  },
  sales: {
    ...staffBaseGrants,
    'crm.lead.read': 'own',
    'crm.lead.write': 'own',
    'crm.opportunity.read': 'own',
    'crm.opportunity.write': 'own',
    // Customers are shared master data, so a salesperson must see all of them to avoid creating a duplicate.
    'customer.read': 'all',
    'customer.write': 'all',
    'quotation.read': 'own',
    'quotation.draft': 'own',
    'quotation.submit': 'own',
    'quotation.send': 'own',
    'quotation.record_acceptance': 'own',
    'quotation.revise': 'own',
    'sales_order.read': 'own',
    'verification.read': 'own',
  },
  // Portal users see and answer only quotations naming their own party (`customer_org`). Staff roles
  // get no portal grant; founder holds every permission at `all` by construction.
  customer_user: {
    'portal.quotation.read': 'customer_org',
    'portal.quotation.respond': 'customer_org',
    'portal.invoice.read': 'customer_org',
    'portal.payment.submit': 'customer_org',
  },
  vendor_user: {},
  pmo: {
    ...staffBaseGrants,
    ...salesReadAllGrants,
    ...salesCreatorGrants,
    'verification.review': 'all',
  },
  operations_head: { ...staffBaseGrants, ...salesReadAllGrants },
  procurement: { ...staffBaseGrants },
  receiver: { ...staffBaseGrants },
};

/** Permissions where the actor must not be someone who prepared the document (separation of duties). */
export const SOD_PERMISSIONS: readonly Permission[] = ['approvals.requests.act'];

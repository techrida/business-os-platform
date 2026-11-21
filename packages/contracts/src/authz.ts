// Permission vocabulary shared by the API (enforcement) and the workspace (what to show).
// Serves the NFR "authorization is deny-by-default": a route needs one of these strings or it is refused.
import { z } from 'zod';

export const PERMISSIONS = [
  'admin.users.read',
  'admin.users.invite',
  'admin.roles.read',
  'admin.roles.write',
  'admin.settings.write',
  // Narrow company-settings writes split out of admin.settings.write (which stays Founder-only): exchange rates,
  // and the finance settings (tax and numbering keys, number series, the Terms page).
  'settings.fx_rate.write',
  'settings.finance.write',
  'approvals.definitions.read',
  'approvals.definitions.write',
  // Publish a saved workflow draft (F1-Q11, D7): the second person after the editor. Held by Management (and the
  // Founder); the API refuses it to whoever saved that draft.
  'approvals.definitions.publish',
  'approvals.groups.write',
  'approvals.delegations.write',
  'approvals.requests.read',
  'approvals.requests.act',
  'approvals.requests.reroute',
  'documents.upload',
  'documents.read',
  // Set a user's profile picture (U12): scope `own` is "my own picture", scope `all` is "anyone's in the tenant".
  'profile.avatar.write',
  'audit.read',
  // The email delivery log (Settings > Email delivery): see sent and failed emails, and resend a failed one.
  // Founder only by default; migration 0128 adds the Founder rows in tenants that hold role rows.
  'email_delivery.read',
  'email_delivery.resend',
  'memo.create',
  'memo.read',
  'memo.update',
  // P2 sales: CRM, customers, quotations and customer verification (KYB).
  'crm.lead.read',
  'crm.lead.write',
  'crm.opportunity.read',
  'crm.opportunity.write',
  // Reopen a lost lead or opportunity. The grant alone is not enough: the code also requires the Founder or a
  // member at level manager or head, so a staff-level holder cannot reopen.
  'crm.lead.reopen',
  'crm.opportunity.reopen',
  'customer.read',
  'customer.write',
  'customer.merge',
  // A customer's terms with the acting entity (app.party_accounts): set its credit limit, and change its owner.
  // On/off (`all`). Migration 0150 writes the rows for tenants that already hold role_permissions rows.
  'customers.credit_limit.write',
  'customers.owner.write',
  'quotation.read',
  'quotation.draft',
  'quotation.submit',
  'quotation.send',
  'quotation.record_acceptance',
  'quotation.revise',
  // See the internal cost and margin on a quotation. Without it the API omits those fields.
  'quotation.cost.read',
  'verification.read',
  'verification.review',
  // Customer portal: a customer user reads and answers their own company's quotations.
  'portal.quotation.read',
  'portal.quotation.respond',
  // P3 sales and invoicing: sales orders, invoices, payments and receivables.
  'sales_order.read',
  'sales_order.confirm',
  'sales_order.mark_billable',
  // F1-Q32: release a confirmed order's delivery hold before its advance is paid, with a reason. Who may release a
  // given order is then decided by `mayReleaseDeliveryHold` (@bos/money-rules) against the live NPR threshold.
  'sales_order.delivery_release',
  'invoice.read',
  'invoice.draft',
  'invoice.submit',
  'invoice.issue',
  'invoice.credit_note',
  // K1: the sales VAT register (issued tax invoices, credit and debit notes by issue date) and its CSV export.
  'vat.sales.read',
  'payment.read',
  'payment.record',
  'payment.verify',
  'payment.allocate',
  'ar.read',
  // F1-Q20/F1-Q26: let a deal whose customer is over its credit limit become a sales order, with a reason.
  'credit.override',
  // Customer portal: a customer user reads their own issued invoices and submits proof of payment.
  'portal.invoice.read',
  'portal.payment.submit',
  // P4 purchases and vendor accounts (kept in one block). Approving money is the workflow's job, so
  // none of these approves a bill or a payment; `payables.payment.request` only starts the request.
  'vendor.read',
  'vendor.write',
  'vendor.activate',
  'vendor.bank.propose',
  'vendor.bank.verify',
  'procurement.pr.create',
  'procurement.pr.read',
  'procurement.sourcing',
  'procurement.po.issue',
  'procurement.receipt.confirm',
  'payables.bill.enter',
  'payables.bill.read',
  'payables.payment.request',
  'payables.vat_register.read',
  // Vendor portal: a vendor user reads their own company's orders and bills and submits to the inbox.
  'portal.vendor.read',
  'portal.vendor.submit',
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
  // Created by migration 0083 (D50): creates, reads (own), qualifies and hands off leads; no quotations.
  'marketing',
  'customer_user',
  'vendor_user',
  'pmo',
  'operations_head',
  'procurement',
  // P4 roles (Kuu D03). `receiver` is dropped: receipts go to `warehouse`. PMO stays the `pmo` key.
  'warehouse',
  'operations_officer',
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

/**
 * Read every customer, quotation and verification record. Reading is not changing: no write, send or review.
 * Invoicing, the approval chains and PMO verification depend on these reads, so D50 leaves them alone.
 */
const salesRecordsReadAllGrants: RoleGrants = {
  'customer.read': 'all',
  'quotation.read': 'all',
  'verification.read': 'all',
};

/** Read every lead and opportunity (Management, Finance and Accountant; the Founder holds it through PERMISSIONS). Finance and Accountant work across the company (Kuu, 2026-11-20, U20a2-Q4). */
const crmReadAllGrants: RoleGrants = {
  'crm.lead.read': 'all',
  'crm.opportunity.read': 'all',
};

/**
 * PMO starts leads for a Sales owner (D50) and keeps reading what it started. That reach
 * is stored as `own`: own read on leads also covers the leads the caller created, and on leads and opportunities
 * the records the caller holds an activity assignment on (read only). Opportunities follow their lead.
 */
const crmCreatedReadGrants: RoleGrants = {
  'crm.lead.read': 'own',
  'crm.opportunity.read': 'own',
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

/**
 * Reopen a lost record (K2): every role that writes leads or opportunities holds the matching reopen at the
 * department, so a manager or head reopens the department's lost records. The code also requires level manager or
 * head (or the Founder), so staff in these roles still cannot reopen. Founder gets both through PERMISSIONS.
 */
const leadReopenGrants: RoleGrants = { 'crm.lead.reopen': 'department' };
const opportunityReopenGrants: RoleGrants = { 'crm.opportunity.reopen': 'department' };

/**
 * Company settings slices (K3). Finance changes exchange rates and the finance settings (tax and numbering keys,
 * number series, the Terms page); the Accountant changes the finance settings only. Everything else in company
 * settings stays on admin.settings.write, which only the Founder holds.
 */
const settingsFinanceGrants: RoleGrants = { 'settings.finance.write': 'all' };
const settingsFxRateGrants: RoleGrants = { 'settings.fx_rate.write': 'all' };

/**
 * See the internal unit cost, cost total and margin on a quotation (D29a). The roles that draft or approve
 * quotations hold it; operations_head, procurement, warehouse and the portal roles do not. Founder gets it
 * through PERMISSIONS. Migration 0055 gives it to existing roles that hold `quotation.draft` or
 * `approvals.requests.act`.
 */
const salesCostReadGrants: RoleGrants = { 'quotation.cost.read': 'all' };

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

/**
 * F1-Q20/F1-Q26: Management and Finance override a deal's credit hold (with a reason, audited). On/off, so `all`.
 * Migration 0104 writes the rows for tenants that already hold role_permissions rows.
 */
const creditOverrideGrants: RoleGrants = { 'credit.override': 'all' };

/**
 * Finance sets a customer's credit limit with the acting entity (not Management); Management changes a customer's
 * owner (not Finance). Founder holds both through PERMISSIONS. On/off, so `all`. Migration 0150 writes the rows for
 * tenants that already hold role_permissions rows.
 */
const customerCreditLimitGrants: RoleGrants = { 'customers.credit_limit.write': 'all' };
const customerOwnerGrants: RoleGrants = { 'customers.owner.write': 'all' };

/**
 * F1-Q32 (R4c1 Q4): Finance, Management and the Founder release a delivery hold (with a reason, audited). The grant
 * lets them ask; the money rule then picks Finance up to the threshold and Management above it (Founder at any
 * amount), never the order's creator. Founder gets it through PERMISSIONS. Migration 0155 writes the rows for
 * tenants that already hold role_permissions rows.
 */
const deliveryReleaseGrants: RoleGrants = { 'sales_order.delivery_release': 'all' };

/**
 * Every staff role sets its own profile picture (U12). Founder holds it at `all` through PERMISSIONS, and so may
 * set anyone's; no other default role holds `admin.users.invite`. Migration 0053 gives existing staff roles `own`,
 * and `all` to founder and to any role that holds `admin.users.invite`. Portal roles get none.
 */
const ownProfileGrants: RoleGrants = { 'profile.avatar.write': 'own' };

/** What every internal user who is not an approver may do in the kernel: their own memos, documents and requests. */
const staffBaseGrants: RoleGrants = {
  ...ownProfileGrants,
  'memo.create': 'own',
  'memo.update': 'own',
  'memo.read': 'own',
  'documents.upload': 'own',
  'documents.read': 'own',
  'approvals.requests.read': 'own',
};

// P4 grants, kept apart from the P1 and P2 constants so a parallel edit merges cleanly. Procurement,
// warehouse and operations_officer hold no `approvals.requests.act`, `payables.payment.request`,
// `payables.bill.enter`, `vendor.bank.verify` or `vendor.activate` (D03, AD5, AD9). They do hold
// `vendor.bank.propose` (procurement only): the proposer is never the verifier.

/** Any internal user who raises requests: they create purchase requests and read their own. */
const prRequesterGrants: RoleGrants = {
  'procurement.pr.create': 'own',
  'procurement.pr.read': 'own',
};
const p4ProcurementGrants: RoleGrants = {
  ...prRequesterGrants,
  'procurement.pr.read': 'all',
  'procurement.sourcing': 'all',
  'procurement.po.issue': 'all',
  'vendor.read': 'all',
  'vendor.write': 'all',
  // Maker side of the bank-account maker-checker (AD9): procurement proposes, finance verifies.
  'vendor.bank.propose': 'all',
  // K3b: procurement opens and submits a vendor's KYB case (vendor.write), so it must also see it. Reading only:
  // no verification.review, so procurement never decides the case it prepared.
  'verification.read': 'all',
};
const p4WarehouseGrants: RoleGrants = { 'procurement.receipt.confirm': 'all' };
/** K1: Finance and Accountant read the sales VAT register; the Founder holds every permission. Migration 0175 seeds rows. */
const salesVatRegisterGrants: RoleGrants = { 'vat.sales.read': 'all' };
const p4AccountantGrants: RoleGrants = {
  'payables.bill.enter': 'all',
  'payables.bill.read': 'all',
  'payables.vat_register.read': 'all',
  'vendor.read': 'all',
};
const p4FinanceGrants: RoleGrants = {
  'vendor.bank.verify': 'all',
  'payables.payment.request': 'all',
  'payables.bill.read': 'all',
  'payables.vat_register.read': 'all',
  'vendor.read': 'all',
};
/** Vendor users see only rows naming their own party (`customer_org` already covers vendor callers in can.ts). */
const p4VendorUserGrants: RoleGrants = {
  'portal.vendor.read': 'customer_org',
  'portal.vendor.submit': 'customer_org',
};

/**
 * What each role may do before an admin edits `app.role_permissions`. The seed copies this into
 * the table, so the table (not this constant) is the live truth at runtime.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, RoleGrants> = {
  founder: founderGrants,
  management: {
    ...ownProfileGrants,
    ...approverGrants,
    // Management seconds workflow changes (F1-Q11): it sees the drafts and publishes one another person saved.
    'approvals.definitions.read': 'all',
    'approvals.definitions.publish': 'all',
    ...crmReadAllGrants,
    ...salesRecordsReadAllGrants,
    ...salesCostReadGrants,
    ...billingReadAllGrants,
    ...creditOverrideGrants,
    ...customerOwnerGrants,
    ...deliveryReleaseGrants,
  },
  finance: {
    ...ownProfileGrants,
    ...approverGrants,
    'audit.read': 'all',
    ...crmReadAllGrants,
    ...salesRecordsReadAllGrants,
    ...salesCreatorGrants,
    ...salesCostReadGrants,
    ...billingReadAllGrants,
    ...billingPreparerGrants,
    ...billingFinanceGrants,
    ...creditOverrideGrants,
    ...customerCreditLimitGrants,
    ...deliveryReleaseGrants,
    ...p4FinanceGrants,
    ...salesVatRegisterGrants,
    ...leadReopenGrants,
    ...settingsFinanceGrants,
    ...settingsFxRateGrants,
  },
  accountant: {
    ...ownProfileGrants,
    ...approverGrants,
    ...crmReadAllGrants,
    ...salesRecordsReadAllGrants,
    ...salesCreatorGrants,
    ...salesCostReadGrants,
    ...billingReadAllGrants,
    ...billingPreparerGrants,
    ...p4AccountantGrants,
    ...salesVatRegisterGrants,
    ...leadReopenGrants,
    ...settingsFinanceGrants,
  },
  sales: {
    ...staffBaseGrants,
    'crm.lead.read': 'own',
    'crm.lead.write': 'own',
    'crm.opportunity.read': 'own',
    'crm.opportunity.write': 'own',
    ...leadReopenGrants,
    ...opportunityReopenGrants,
    // Customers are shared master data, so a salesperson must see all of them to avoid creating a duplicate.
    'customer.read': 'all',
    'customer.write': 'all',
    'quotation.read': 'own',
    'quotation.draft': 'own',
    'quotation.submit': 'own',
    'quotation.send': 'own',
    'quotation.record_acceptance': 'own',
    'quotation.revise': 'own',
    ...salesCostReadGrants,
    'sales_order.read': 'own',
    'verification.read': 'own',
  },
  // Marketing starts and works its own leads (create, read, qualify, hand off) and nothing else in sales: no
  // opportunity or quotation grant. Its customer read reaches only customers it owns (D55-6). Migration 0083
  // inserted the base rows; 0088 adds the profile picture and customer read rows 0083 missed.
  marketing: {
    ...staffBaseGrants,
    'crm.lead.read': 'own',
    'crm.lead.write': 'own',
    ...leadReopenGrants,
    'customer.read': 'own',
  },
  // Portal users see and answer only quotations naming their own party (`customer_org`). Staff roles
  // get no portal grant; founder holds every permission at `all` by construction.
  customer_user: {
    'portal.quotation.read': 'customer_org',
    'portal.quotation.respond': 'customer_org',
    'portal.invoice.read': 'customer_org',
    'portal.payment.submit': 'customer_org',
  },
  vendor_user: p4VendorUserGrants,
  pmo: {
    ...staffBaseGrants,
    ...crmCreatedReadGrants,
    ...salesRecordsReadAllGrants,
    ...salesCreatorGrants,
    ...salesCostReadGrants,
    ...leadReopenGrants,
    'verification.review': 'all',
  },
  // D50: Operations does not work leads, so no lead or opportunity read.
  operations_head: { ...staffBaseGrants, ...salesRecordsReadAllGrants },
  procurement: { ...staffBaseGrants, ...p4ProcurementGrants },
  warehouse: { ...staffBaseGrants, ...p4WarehouseGrants },
  operations_officer: { ...staffBaseGrants, ...prRequesterGrants },
};

/** Permissions where the actor must not be someone who prepared the document (separation of duties). */
export const SOD_PERMISSIONS: readonly Permission[] = ['approvals.requests.act'];

# Features

Business OS serves staff users through the **Workspace** (`apps/workspace`) and external counterparties through the **Portal** (`apps/portal`). Every screen enforces permissions and record scopes on the server, hiding actions and data a role is not allowed to see.

## Roles and workspace navigation

Thirteen built-in roles are seeded by default and can be adjusted in **Settings > Access**:

| Role                 | Typical responsibilities                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `founder`            | Full access, final high-value approvals, company settings, audit access, email delivery log                                                         |
| `management`         | Commercial oversight, mid-tier and high-discount approvals, workflow publishing, credit and delivery overrides, customer owner reassignment         |
| `finance`            | Payment verification, invoice issuance, credit/debit notes, vendor bank verification, payment requests, VAT registers, credit limits, FX rates      |
| `accountant`         | Commercial review, sales order confirmation, invoice drafting, payment recording and allocation, vendor bill entry, VAT registers, finance settings |
| `sales`              | Leads, opportunities, customers, activities, quotations, and acceptance tracking                                                                    |
| `marketing`          | Lead creation, qualification, and handover to Sales                                                                                                 |
| `pmo`                | Lead intake for Sales, customer and vendor KYB verification review                                                                                  |
| `operations_head`    | Fallback department-head approvals and commercial visibility                                                                                        |
| `procurement`        | Vendor onboarding, bank detail proposals, purchase requests, RFQs, and purchase orders                                                              |
| `warehouse`          | Confirming goods and service receipts against purchase orders                                                                                       |
| `operations_officer` | Creating and tracking own purchase requests                                                                                                         |
| `customer_user`      | Customer portal access (own company quotations, milestones, invoices, and payment proofs)                                                           |
| `vendor_user`        | Vendor portal access (own onboarding documents, RFQs, purchase orders, bills, and bank details)                                                     |

## CRM and quotations

### Customers

- Create and manage customer organizations with legal names, structured street/city/country addresses, multiple labeled E.164 phone numbers (with Nepal `+977` mobile and landline validation), and primary contacts.
- Validate 9-digit PAN/VAT numbers for Nepal-based customers while allowing foreign tax identifiers for international accounts.
- Manage per-entity credit limits (Finance) and account owners (Management), merge duplicate customer records, and upload bulk customer lists via CSV import with row-level duplicate and validation previews.

### Leads and opportunities

- Track leads across six stages: `new`, `contacted`, `qualified`, `converted`, `lost`, and `on_hold`.
- Detect potential duplicates before conversion.
- Support cross-team lead intake: Finance, Accountant, and PMO users can open leads for a Sales owner while retaining read access to leads they created. Marketing hands qualified leads over to Sales according to configured handover rules.
- Convert qualified leads into opportunities tracked across eight stages: `qualified`, `requirement_received`, `proposal_sent`, `quotation_sent`, `negotiation`, `won`, `lost`, and `on_hold`, with full stage history.
- Reopen lost leads or opportunities at the manager or department-head level, and review outcomes in the **Lost deals** report.

### Activities and tasks

- Plan and log calls, meetings, emails, and notes tied to leads and opportunities.
- Assign follow-ups to team members. Assigned users automatically receive read-only visibility on the parent lead or opportunity.

### Customer and vendor verification (KYB)

- Track onboarding compliance cases across `draft`, `submitted`, `approved`, `rejected`, and `expired` states.
- Review required checklist documents (such as registration certificate, PAN/VAT certificate, authorized signatory ID, and address proof) with per-item statuses (`missing`, `provided`, `accepted`, `rejected`).
- Enforce separation of duties so the person who prepared a vendor case does not decide its approval.

### Quotations

- Manage quotations through ten states: `draft`, `submitted`, `returned`, `approved`, `sent`, `accepted`, `rejected`, `expired`, `cancelled`, and `superseded`.
- Create versioned revisions while preserving earlier versions as read-only history.
- Quote in **NPR**, **INR**, or **USD** using configured FX rates frozen at submission, with line-item and document discounts, configurable VAT codes (including 13% VAT, exempt, zero-rated, and reverse charge), and split payment schedules.
- Keep internal unit costs and margins hidden from roles without `quotation.cost.read`.
- Attach saved rich-text terms presets (scope, delivery, payment terms) and render branded quotation PDFs through Gotenberg.
- Automatically expire overdue sent quotations via a scheduled background job.
- Record customer acceptance or rejection with supporting evidence (`contract`, `purchase_order`, or `signed_quote`), either by staff or directly from the customer portal.

## Sales and invoicing

### Sales orders

- Create sales orders from accepted quotations and move them through `draft`, `confirmed`, `completed`, and `cancelled` states.
- Check customer credit exposure at confirmation. Orders exceeding a customer's credit limit require an audited credit override from Finance or Management.
- Track payment schedule lines and mark milestones billable.
- Hold delivery until required advance payments are settled, or record an audited delivery-hold release (Finance up to the configured NPR threshold, Management above it, or Founder at any amount, never by the order creator).

### Invoices, credit notes, and debit notes

- Support four document kinds: `tax_invoice`, `proforma`, `credit_note`, and `debit_note`.
- Follow a maker-checker lifecycle (`draft`, `submitted`, `returned`, `approved`, `issued`, `discarded`) where Accountants draft and submit while Finance issues approved invoices and adjustment notes.
- Track settlement separately (`unpaid`, `partly_paid`, `paid`, `overdue`, `credited`).
- Stamp every issued tax invoice, credit note, and debit note with its frozen Bikram Sambat issue date and Nepali fiscal year, render a self-contained PDF, and compute proportional NPR equivalents on partial foreign-currency credit notes.

### Payments and receivables

- Record payments across five methods: `bank_transfer`, `qr`, `wire`, `cheque`, and `cash`, from either staff entry or customer portal proof submission.
- Move payments through `submitted`, `verified`, `rejected`, `withdrawn`, and `reversed` states with maker-checker enforcement (the Finance verifier cannot be the person who recorded the payment).
- Allocate verified payments across one or more open invoices and track remaining customer balances.
- Review open balances in **Receivables aging** (`current`, `1-30`, `31-60`, `61-90`, and `91+` days), inspect per-customer receivable ledgers, and log customer payment promises with automated follow-up tracking.

### Sales VAT register and subledger postings

- View all issued tax invoices, credit notes, and debit notes by issue date in the **Sales VAT register**, complete with Bikram Sambat dates and CSV export.
- Post balanced AR and AP subledger entries automatically alongside invoice issuance, credit/debit notes, verified payments, and payable bills.

## Procurement and payables

### Vendors

- Manage vendors classified as `company`, `sole_proprietor`, `individual`, or `foreign` through `draft`, `pending_kyc`, `under_review`, `approved`, `suspended`, `blocked`, and `archived` states.
- Validate 9-digit Nepal PAN numbers for domestic vendors and monitor KYB document expiry with scheduled jobs.
- Import vendors in bulk from CSV with duplicate and validation previews.
- Protect vendor payouts with a maker-checker bank account workflow (`proposed`, `active`, `retired`, `rejected`): Procurement or the vendor proposes bank details, Finance verifies them, and stored account details are encrypted at the field level.

### Purchase requests, sourcing, and purchase orders

- Submit `goods`, `service`, or `mixed` purchase requests through `draft`, `submitted`, `returned`, `dept_approved`, `sourcing`, `commitment_pending`, `approved`, `po_issued`, `closed`, `rejected`, and `cancelled` states.
- Open **Requests for quotation (RFQs)** (`open`, `closed`, `recommended`, `cancelled`), collect competing vendor quotes (from staff entry or the vendor portal), and record a sourcing recommendation before commitment approval.
- Issue **Purchase orders** (`draft`, `issued`, `partially_received`, `fully_received`, `amendment_pending`, `closed`, `short_closed`, `cancelled`) with Gotenberg PDF generation, Bikram Sambat issue dates, and formal amendment and short-close paths.

### Receipts

- Record `goods` and `service` receipts (`draft`, `confirmed`, `reversed`, `discarded`) against issued purchase orders.
- Support partial deliveries across multiple receipts and reverse erroneous receipts with automatic purchase order status updates.

### Vendor bills, three-way match, and payment requests

- Review vendor-submitted bills in the **Bill inbox** and enter `bill` and `vendor_credit_note` records (`draft`, `matching`, `variance`, `exception_pending`, `pending_approval`, `approved`, `partially_paid`, `paid`, `voided`, `rejected`, `discarded`).
- Run automatic three-way matching against purchase orders and confirmed receipts (`not_required`, `pending`, `matched`, `variance`, `exception_approved`), routing out-of-tolerance variances through an exception approval step before bill approval.
- Apply effective-dated TDS withholding tax codes to payable bills.
- Submit `settlement` or `advance` **Payment requests** (`draft`, `pending_approval`, `approved`, `rejected`, `cancelled`) through the approval engine. Payment requests authorize payouts, while actual bank disbursement occurs outside Business OS.
- Export approved vendor bills and vendor credit notes from the **Purchase VAT register** with Bikram Sambat dates and Nepali fiscal years.

## Platform capabilities

### Access settings and departments

- Configure company departments (`active` or `retired`) and assign staff memberships with a role and level (`staff`, `manager`, `head`).
- Manage permissions in **Settings > Access** across four views: **By area**, **By role**, **Check a person** (inspect effective reach and why an assignment is allowed or denied), and **History**.
- Enforce assignment rules automatically so staff cannot assign work upward or across departments unless a configured handover rule allows it.

### Approval engine and memos

- Manage versioned approval workflow definitions in **Settings > Workflows** with two-person draft-and-publish governance (the editor who saves a draft cannot publish it).
- Route approvals automatically by NPR amount bands (defaults: Management above NPR 1,00,000 and Founder above NPR 10,00,000) and discount rules (discounts strictly above 12% add Management approval).
- Support sequential steps, group steps, date-bound delegations, SLA reminder timers, and mandatory comments on return or rejection.
- Enforce separation of duties on every approval action so a requester or preparer cannot approve their own record.
- Work through pending items in **Work > Inbox**, and use **Work > Memos** (`draft`, `submitted`, `approved`, `returned`, `rejected`) for internal approval requests with downloadable PDF output.

### Audit trail

- Capture every write to business tables automatically through database triggers with actor identity, before/after state, correlation ID, IP address, and user agent.
- Link events into a monthly SHA-256 hash chain and verify monthly integrity via the audit verification API.

### Documents and notifications

- Upload supporting documents up to 25 MiB (PDF, PNG, JPEG, WebP, DOCX, XLSX, PPTX, CSV) with magic-byte validation, ClamAV antivirus scanning, SHA-256 digests, and 60-second single-use signed download URLs.
- Preview PDF documents directly in the Workspace and Portal using the built-in `pdf.js` viewer.
- Track unread notifications in the header bell and **Work > Inbox**, and inspect or resend failed or bounced emails in **Settings > Email delivery**.

### Company settings

Configure organization behavior under **Settings** with every change recorded in the audit trail:

- **Company**: Company profile and logo, quotation document templates, South Asian or international number and date formats, and saved rich-text terms.
- **Organisation**: Users and invitations, departments, access policies, approval workflows, and email delivery logs.
- **Finance**: Currencies and FX rates, tax and TDS codes, document numbering series, and company bank and expense accounts.
- **Sales and purchasing**: Credit, delivery-hold, and procurement tolerance settings.

## Customer and vendor portal

A dedicated Next.js application (`apps/portal`) isolates external users from internal staff screens, internal notes, and cost margins.

### Customer portal (`/`)

- Review sent quotations, inspect PDFs, and accept or reject quotations with uploaded acceptance evidence.
- Track sales-order billing milestones.
- View issued invoices, download tax invoice PDFs, and see settlement status.
- Upload payment proofs and track verification status.

### Vendor portal (`/vendor`)

- Upload onboarding KYB documents and check onboarding status.
- View open RFQs and submit vendor quotes (for approved vendors).
- View issued purchase orders and download PDFs.
- Submit vendor bills to the payables bill inbox and monitor bill status.
- Propose bank account details for Finance verification (for approved vendors).

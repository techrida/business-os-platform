# Business OS

Open-source B2B operations platform by Techrida for Nepali trading and service companies. Run CRM, quotations, sales orders, invoicing, procurement, and payables in one system with built-in approvals and a tamper-evident audit trail.

[![CI](https://github.com/techrida/business-os-platform/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/techrida/business-os-platform/actions/workflows/ci.yml?query=branch%3Amain) [![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/techrida/business-os-platform/badge)](https://scorecard.dev/viewer/?uri=github.com/techrida/business-os-platform)

## What it is and who it is for

Most B2B teams manage quotes in spreadsheets, chase discount approvals in chat, send invoices by email, and reconcile vendor bills from separate folders. Business OS puts those commercial and financial records in one self-hosted platform where every record carries an owner, a status, an approval path, supporting documents, and an audit history.

It is built for:

- **SME owners and management teams** who need spend controls, discount governance, and clear visibility into receivables and payables.
- **Finance and accounting teams** who review quotations, verify payment proofs, match vendor bills against purchase orders and receipts, and prepare VAT registers.
- **Sales and procurement staff** who track leads, issue versioned quotations, collect vendor quotes, and issue purchase orders.
- **Customers and vendors** who respond to quotes, upload payment proofs, submit bills, and upload verification documents through a dedicated portal.
- **Developers and operators** who want a self-hosted TypeScript monorepo on PostgreSQL, Valkey, and ZITADEL that runs on a single Linux server with Docker Compose.

## Key features

### CRM and quotations

- **Customers and bulk imports.** Store customer records with Nepal 9-digit PAN/VAT validation, international tax IDs, structured addresses, credit limits, merges, and CSV import.
- **Leads, opportunities, and activities.** Move deals from lead intake and qualification through stage tracking, planned follow-ups, and lost-deal reporting.
- **Customer and vendor KYB verification.** Review registration certificates, PAN/VAT certificates, signatory IDs, and address proofs through a structured checklist workflow.
- **Versioned quotations.** Build multi-currency quotations (NPR, INR, USD) with frozen FX rates, payment schedules, rich-text terms, Gotenberg PDF output, and acceptance evidence capture.

### Sales and invoicing

- **Sales orders and holds.** Convert accepted quotations into sales orders with credit-limit checks, billable milestone tracking, and audited advance-payment delivery holds.
- **Invoices, credit notes, and debit notes.** Issue tax invoices, proformas, credit notes, and debit notes with frozen Bikram Sambat dates and PDF rendering.
- **Payments and receivables.** Record and verify customer payments (bank transfer, QR, wire, cheque, cash) with maker-checker separation, multi-invoice allocation, aging buckets, and payment promises.
- **Sales VAT register.** Review issued tax invoices, credit notes, and debit notes by issue date and export to CSV.

### Procurement and payables

- **Vendors and bank verification.** Onboard domestic and foreign vendors with KYB expiry tracking, maker-checker bank account verification, and field-level bank encryption.
- **Purchase requests, RFQs, and purchase orders.** Route purchase requests through department approval, compare vendor quotes on RFQs, and issue approved purchase orders with PDF output.
- **Goods and service receipts.** Confirm partial or full deliveries against purchase orders, with receipt reversal support.
- **Vendor bills, three-way match, and payment requests.** Match vendor bills against purchase orders and receipts with tolerance checks, exception approvals, effective-dated TDS withholding codes, payment approval requests, and a purchase VAT register.

### Platform

- **Roles and access.** Deny-by-default permissions across 13 built-in roles, department hierarchy levels (`staff`, `manager`, `head`), record scopes, and assignment rules.
- **Approvals.** Versioned workflow rules with NPR amount bands, discount triggers above 12%, date-bound delegations, SLA reminders, internal memos, and strict separation of duties.
- **Audit.** Append-only, database-triggered audit trail covering every business table, linked in a monthly SHA-256 hash chain with verification.
- **Documents.** Private storage up to 25 MiB per file with magic-byte validation, ClamAV antivirus scanning, SHA-256 digests, 60-second single-use download links, and in-browser PDF viewing.
- **Notifications.** In-app notification bell and approval inbox, transactional email outbox with retries, an email delivery log with resend, and signed Postal bounce webhooks.
- **Customer and vendor portal.** Separate web app where customers view quotes, milestones, and invoices and upload payment proof, while vendors complete onboarding, quote on RFQs, view purchase orders, submit bills, and propose bank details.

## Screenshots

Screenshots will be added once public media assets are published in this repository.

## Tech stack

| Layer                     | Technology                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| Language and runtime      | TypeScript 6, Node.js 24, pnpm 11 workspaces                         |
| Backend API and worker    | NestJS 12, BullMQ, Drizzle ORM, Zod 4, Pino                          |
| Frontend apps             | Next.js 16, React 19, Radix UI, React Aria, TipTap, pdf.js           |
| Database and queues       | PostgreSQL 16 (with pgBackRest), Valkey 9.1                          |
| Identity and edge         | ZITADEL v4.20.1 (OIDC and Login V2), Caddy 2.11                      |
| Document and mail tooling | Gotenberg 8.40 (Chromium PDF), ClamAV 1.5, Nodemailer, Mailpit (dev) |
| Testing and quality       | Vitest, Testcontainers, Playwright, k6, ESLint, Prettier, gitleaks   |

## Quick start

Prerequisites: Linux (or WSL2 on Windows), Node.js 24, pnpm 11, Docker with Compose v2, and OpenSSL.

```bash
# 1. Create a local .env with random development secrets
bash infra/scripts/make-dev-env.sh

# 2. Install dependencies and build workspace packages
pnpm install --frozen-lockfile
pnpm build

# 3. Start core services (PostgreSQL, Valkey, ZITADEL, Caddy, Mailpit)
pnpm stack:up

# 4. Export Caddy's local root CA certificate (trust .dev/caddy-root.crt in your browser)
bash infra/scripts/export-dev-ca.sh

# 5. Apply database migrations and verify tenancy constraints
bash infra/scripts/migrate-dev.sh

# 6. Provision ZITADEL roles, OIDC clients, and development personas
pnpm seed
```

Start the API, worker, staff workspace, and portal on your host (binding to `0.0.0.0` so Caddy can proxy to them) or run the containerized `app` profile. See [Getting started](docs/getting-started.md) for the complete local setup, environment loading, CA trust steps, and troubleshooting.

Local URLs once running:

- Staff workspace: `https://app.localhost`
- Customer and vendor portal: `https://portal.localhost`
- API: `https://api.localhost`
- Identity provider (ZITADEL Login V2): `https://auth.localhost`
- Local email catcher (Mailpit): `https://mail.localhost`

## Project layout

| Path                   | Purpose                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/api`             | NestJS HTTP API (`src/main.ts`) and BullMQ worker (`src/worker.ts`)                                          |
| `apps/workspace`       | Staff web application (Next.js BFF)                                                                          |
| `apps/portal`          | Customer and vendor portal (Next.js BFF)                                                                     |
| `packages/contracts`   | Shared Zod schemas, DTOs, permissions, and validation rules                                                  |
| `packages/db`          | Drizzle schema, SQL migrations, tenancy checks, and audit checks                                             |
| `packages/locale`      | Decimal arithmetic, lakh/crore formatting, amounts in words, Kathmandu time, and Bikram Sambat dates         |
| `packages/money-rules` | Pure pricing, tax, FX, allocation, matching, withholding, and approval-band calculations                     |
| `packages/pdf-viewer`  | Shared `pdf.js` canvas viewer used by the workspace and portal                                               |
| `infra`                | Docker Compose stacks, Caddy config, PostgreSQL backup scripts, ClamAV config, and Login V2 build            |
| `tools`                | ZITADEL seed CLI (`tools/seed-zitadel`), database helpers, and the local verification gate (`tools/gate.sh`) |
| `perf`                 | k6 load and approval performance test scripts                                                                |

## Documentation

- [Getting started](docs/getting-started.md): End-to-end local development setup, environment variables, Compose profiles, and troubleshooting.
- [Architecture](docs/architecture.md): Modular monolith layout, identity and session boundaries, data tenancy, audit chain, and document scanning.
- [Features](docs/features.md): Module-by-module guide to user-facing workflows, roles, and controls.

## Built for Nepal first

Business OS treats Nepali business rules as core behavior rather than add-ons. Amounts use exact `decimal.js` arithmetic with half-up rounding, South Asian lakh and crore grouping (`NPR 12,50,000.00`), and cheque-style amounts in words alongside INR and USD. Nepali counterparties validate 9-digit PAN/VAT numbers and `+977` mobile and landline formats. Tax invoices, purchase orders, vendor bills, and sales and purchase VAT registers record Bikram Sambat dates in `Asia/Kathmandu` time and Shrawan-to-Asar Nepali fiscal years (`2082/83`), with configurable 13% VAT and effective-dated TDS withholding codes.

## Contributing, security, and license

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and run `bash tools/gate.sh` to verify your changes locally.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces.
- Report suspected vulnerabilities privately by following [SECURITY.md](SECURITY.md).
- Business OS is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See the `LICENSE` file in the repository root for full terms.

// Business OS system map: the single source of truth for map.html.
// Schema and collapse/phase rules: SCHEMA.md. Edit here, commit, re-publish.
// Sources: _analysis/business-os/BLUEPRINT.md (KB: Techrida/projects/business-os/docs/BLUEPRINT.md),
// the meeting of 2026-11-05 (study guide 4.8, 4.10, 4.13) and decisions D1–D6.
(function () {
  const E = [], R = [];
  // el(id, parent, kind, name, tech, since, desc, extra)
  const el = (id, parent, kind, name, tech, since, desc, x) => E.push(Object.assign({ id, parent, kind, name, tech: tech || undefined, since, desc }, x || {}));
  // rel(src, dst, label, tech, since, extra)
  let n = 0;
  const rel = (src, dst, label, tech, since, x) => R.push(Object.assign({ id: "r" + (++n), src, dst, label, tech: tech || undefined, since }, x || {}));

  // ───────────────────────── People ─────────────────────────
  el("staff", null, "person", "Staff", "Workspace users", "P0", "Company employees. Each role sees only what its permissions and record scope allow.", { refs: ["Blueprint §1"] });
  el("staff-admin", "staff", "person", "Company admin (IT)", null, "P0", "Runs the server, invites staff, sets roles, thresholds and numbering.", { refs: ["Blueprint §1"] });
  el("founder", "staff", "person", "Founder", null, "P2", "Final approver above NPR 10,00,000. Hardware passkey plus step-up before approving.", { refs: ["Blueprint §1, §3.3"] });
  el("mgmt", "staff", "person", "Management team", "configurable group", "P2", "Approves NPR 1,00,001–10,00,000 and any discount above 12%. Any one member is enough.", { refs: ["Threshold tables p1"] });
  el("finance", "staff", "person", "Accountant & Finance", null, "P2", "Reviews quotes, issues invoices, verifies payment proof, checks customer and vendor verification.", { refs: ["Blueprint §1"] });
  el("sales", "staff", "person", "Sales & BD", null, "P2", "Leads, opportunities, quotations, sales orders.", { refs: ["Blueprint §1"] });
  el("procurement", "staff", "person", "Procurement & Ops", null, "P4", "Purchase requests, RFQs, POs, receipts.", { refs: ["Blueprint §1"] });
  el("customer", null, "person", "Customer user", "Client portal", "P2", "A person at a customer company. Invited by their own org admin, or provisioned by SCIM. Sees only their company's quotes and invoices.", { refs: ["Blueprint §1, §3.1a"] });
  el("vendor", null, "person", "Vendor user", "Vendor portal", "P4", "A supplier's staff member. Must pass verification (PAN, registration, bank account checked by two people) before the first payment.", { refs: ["Meeting 4.10 (vendor accounts + ID verification)", "Epics US-401"] });

  // ───────────────────────── External systems ─────────────────────────
  el("cust-idp", null, "external", "Customer's identity provider", "Entra ID / Google Workspace", "P2", "Optional. Big customers can push their users to us automatically (SCIM) instead of inviting them one by one.", { proposed: true });
  el("smarthost", null, "external", "Email relay", "Amazon SES or Postmark", "P1", "Postal hands mail to a relay with a good sending reputation. Office IPs usually land in spam.", { refs: ["Blueprint §3.5"] });
  el("offsite", null, "external", "Offsite backup", "S3-compatible bucket (e.g. Backblaze B2)", "P0", "Encrypted copies of the database and files, away from the office.", { refs: ["Blueprint §5 (3-2-1)"] });
  el("github", null, "external", "GitHub", "Repo + Actions", "P0", "Source code and the CI gate. Nothing merges unless CI is green.", { refs: ["Blueprint §5 Maintainability"] });
  el("idv", null, "external", "ID-check provider", "Didit / Shufti (pilot)", "P4", "Optional automated document and selfie checks. Nepal has no public NID/PAN API, so Stage 1 starts with a manual checklist.", { proposed: true, refs: ["research/identity-verification.md"] });

  // ───────────────────────── Business OS ─────────────────────────
  el("bos", null, "system", "Business OS", "modular monolith on one office server", "P0", "One system where every important record has an owner, a status, an approval path, evidence, a notification trail and an audit history.", { refs: ["PRD p2", "Blueprint §0"] });

  // Front door
  el("edge", "bos", "container", "Front door", "Caddy · Tailscale", "P0", "How people reach the system. Admin goes through a private tunnel. Customers and vendors use a hardened public address.", { refs: ["D5", "D6"] });
  el("tailscale", "edge", "component", "Admin tunnel", "Tailscale / WireGuard", "P0", "Private network for staff off-site and for admin. No public SSH or database port ever.", { licence: "BSD-3", refs: ["Meeting 4.13", "Blueprint §6"] });
  el("public-ip", "edge", "component", "Public entry", "Static IPv4 · firewall", "P2", "Opens the client portal and login to the internet once customers need them. Only ports 80/443 are open.", { refs: ["D6"], nfr: ["TLS 1.2+", "rate limits on login and API"] });
  el("caddy", "edge", "component", "Reverse proxy", "Caddy 2", "P0", "Terminates HTTPS with automatic certificates, sets security headers and routes hostnames to the apps.", { licence: "Apache-2.0", changes: { P2: "Goes public: rate limits, strict headers. Only the portal, login and API hostnames are reachable from outside; the admin hostnames stay on Tailscale." } });

  // Apps
  el("apps", "bos", "container", "Apps", "Next.js 15 · React · TypeScript", "P0", "The screens. Two apps in Stage 1 plus a small vendor portal. All of them call one API.", { licence: "MIT" });
  el("workspace", "apps", "container", "Workspace", "Next.js 15", "P0", "The staff app.", { licence: "MIT", nfr: ["LCP < 1.5 s on LAN", "WCAG 2.1 AA"] });
  el("ws-shell", "workspace", "component", "Shell & sign-in", "OIDC code + PKCE", "P0", "Layout, navigation and the login redirect. Holds the session cookie (__Host-, Secure, HttpOnly).");
  el("ws-admin", "workspace", "component", "Admin", null, "P1", "Users, roles and record scope, approval thresholds, numbering series, currencies and tax.");
  el("ws-inbox", "workspace", "component", "Approval inbox", null, "P1", "Everything waiting for you, with the reason it needs you (\"Founder approval because NPR equivalent exceeds 10,00,000\").", { refs: ["Pack p7–9"] });
  el("ws-crm", "workspace", "component", "CRM screens", null, "P2", "Leads, pipeline board, activities, customers and contacts.");
  el("ws-quotes", "workspace", "component", "Quote builder", null, "P2", "Line items, tax, discount and currency, with a live preview of who will have to approve.");
  el("ws-review", "workspace", "component", "Verification review", null, "P2", "Finance checks customer (and later vendor) evidence here.", { changes: { P4: "Adds the vendor queue and the second-reviewer step for bank details." } });
  el("ws-sales", "workspace", "component", "Sales orders", null, "P3", "Turns accepted quotes into orders with a payment schedule.", { proposed: true });
  el("ws-billing", "workspace", "component", "Invoices & receivables", null, "P3", "Draft, approve and issue invoices; verify payment proof; AR aging.");
  el("ws-purch", "workspace", "component", "Purchases", null, "P4", "Purchase requests, RFQ comparison, POs, receipts, vendor bills, vendor list.");

  el("portal", "apps", "container", "Client portal", "Next.js 15", "P2", "The customer app. Customers never see costs, margins or internal comments.", { licence: "MIT", refs: ["PRD p5"], nfr: ["LCP < 2.5 s on 4G"] });
  el("cp-shell", "portal", "component", "Portal shell & sign-in", "OIDC", "P2", "Login through the customer's ZITADEL organisation.");
  el("cp-team", "portal", "component", "My team", null, "P2", "The customer's org admin invites and removes their own users.");
  el("cp-quotes", "portal", "component", "Quotes", null, "P2", "View the frozen PDF, accept or reject with notes, upload a PO.");
  el("cp-invoices", "portal", "component", "Invoices & payment proof", null, "P3", "See invoices and upload proof of payment.");

  el("vportal", "apps", "container", "Vendor portal", "Next.js 15", "P4", "Small supplier app: onboarding and verification, quoting on RFQs, POs and bills. The blueprint put this in R5; the meeting asked for vendor accounts in Stage 1.", { licence: "MIT", proposed: true, refs: ["Meeting 4.10"] });
  el("vp-shell", "vportal", "component", "Vendor sign-in", "OIDC", "P4", "Login through the vendor's ZITADEL organisation.");
  el("vp-onboard", "vportal", "component", "Onboarding & verification", null, "P4", "Company details, PAN/VAT, registration, bank letter.");
  el("vp-rfq", "vportal", "component", "RFQ responses", null, "P4", "Submit a quote against an RFQ.");
  el("vp-po", "vportal", "component", "POs & bills", null, "P4", "See purchase orders, submit bills and delivery evidence.");

  // Accounts (ZITADEL)
  el("accounts", "bos", "container", "Accounts", "ZITADEL v4 (OIDC, SCIM)", "P0", "The identity provider, run unmodified as its own service. Login, MFA, organisations and provisioning. Keycloak is the fallback if the pilot fails.", { licence: "AGPL-3.0 (unmodified)", refs: ["D2", "Blueprint §3.1"], nfr: ["login p95 ≤ 500 ms", "lockout after 5 failures / 15 min"] });
  el("z-login", "accounts", "component", "Login & MFA", "Passkeys (WebAuthn) · TOTP · Argon2id", "P0", "Password plus a second factor. Passkeys preferred, no SMS, recovery codes.", { changes: { P1: "MFA required for everyone (AAL2). Founder, Finance and bank-detail roles need hardware passkeys and step-up before approvals." }, nfr: ["staff session 1 h idle / 24 h max", "privileged 15 min idle / 12 h max"] });
  el("z-bootstrap", "accounts", "component", "Bootstrap admin", "first-instance login", "P0", "The one-off admin ZITADEL creates at install. Disabled once named admins with passkeys exist.", { until: "P1" });
  el("z-oidc", "accounts", "component", "Token issuer", "OpenID Connect · JWKS", "P0", "Issues signed ID and access tokens. Publishes its public keys (JWKS) so the API can check tokens without calling back each time.");
  el("z-orgs", "accounts", "component", "Organisations", "ZITADEL orgs", "P0", "One org per company: our staff, each customer company, each vendor.");
  el("z-org-staff", "z-orgs", "component", "Staff org", null, "P0", "Our employees.");
  el("z-org-cust", "z-orgs", "component", "Customer orgs", "one per customer company", "P2", "Each customer company manages its own users.");
  el("z-org-vendor", "z-orgs", "component", "Vendor orgs", "one per vendor", "P4", "Created when Procurement invites a vendor.");
  el("z-scim", "accounts", "component", "SCIM provisioning", "SCIM 2.0", "P2", "Lets a customer's own directory create, update and remove their users here automatically.", { proposed: true, collapsed: true });
  el("scim-ep", "z-scim", "component", "SCIM server", "/Users · /Groups · bearer token", "P2", "Receives create/update/deactivate calls.");
  el("scim-map", "z-scim", "component", "Org & role mapping", null, "P2", "Puts each pushed user in the right customer org with a default role.");
  el("scim-deprov", "z-scim", "component", "Deprovisioning", null, "P2", "When the customer deactivates someone, their sessions are revoked here at once.");
  el("z-actions", "accounts", "component", "Events & Actions", "signed webhooks", "P1", "Tells the API when users or orgs change so it can keep its own copy in step.");
  el("z-db", "accounts", "store", "Accounts database", "PostgreSQL 16 (own database)", "P0", "ZITADEL's events and projections. Kept apart from business data.");

  // API
  el("api", "bos", "container", "API", "NestJS 11 · TypeScript · Zod · Drizzle", "P0", "One deployable service with strict module boundaries. Every call checks who you are, what your role allows and which records you may touch.", { licence: "MIT", refs: ["Blueprint §6"], nfr: ["reads p95 < 300 ms", "writes p95 < 500 ms", "100% endpoints have a deny test"] });

  el("kernel", "api", "component", "Platform kernel", null, "P0", "The six platform services every module reuses: owner, status, approval path, evidence, notification trail, audit.", { refs: ["Blueprint §0, §3"] });
  el("k-guard", "kernel", "component", "Auth guard", "jose (JWT/JWKS)", "P0", "Checks the access token's signature, issuer, audience and expiry on every request.", { licence: "MIT" });
  el("k-authz", "kernel", "component", "Permissions & scope", "can(user, action, record)", "P1", "Role → permissions; assignment → record scope (own, department, customer org, all). Separation of duties: you can never approve what you created.", { refs: ["Blueprint §3.2"], nfr: ["decision < 5 ms"] });
  el("k-users", "kernel", "component", "User & org sync", null, "P1", "Keeps a local copy of users, orgs and memberships from ZITADEL events.");
  el("k-tenancy", "kernel", "component", "Tenancy", "tenant_id + organization_id", "P0", "Every business table carries both ids from the first migration. Scoped repositories add them to every query. Keeps the freemium SaaS track open.", { refs: ["D4", "Meeting 4.6 (freemium SaaS)"] });
  el("k-audit", "kernel", "component", "Audit log", "append-only · hash chain", "P1", "Who did what, before/after values, IP, correlation id. The app's DB role can only INSERT.", { refs: ["Pack p11"], nfr: ["100% of state changes audited", "kept ≥ 7 years"] });
  el("k-docs", "kernel", "component", "Documents & evidence", "StorageAdapter · SHA-256", "P1", "Uploads land in quarantine, get scanned, then become available. Downloads only after a permission check.", { nfr: ["max 25 MB", "scan < 10 s", "signed links expire in 60 s"] });
  el("k-notify", "kernel", "component", "Notifications", "transactional outbox", "P1", "Writes the message in the same transaction as the change, so nothing is lost if the server dies. In-app plus email.", { nfr: ["in-app < 2 s", "email handed over < 60 s"], changes: { P2: "First customer-facing emails. No passwords, payroll data or permanent sensitive links in email." } });
  el("k-config", "kernel", "component", "Settings, numbers, money", "decimal.js · locked sequences · BS dates", "P1", "Versioned settings, gap-free document numbers, NPR/INR/USD with the NPR snapshot, Asia/Kathmandu time.", { licence: "MIT", nfr: ["0 duplicate numbers"] });
  el("k-obs", "kernel", "component", "Health & logs", "pino · correlation ids", "P0", "/health for monitors, structured logs, error reporting.", { licence: "MIT" });

  el("approvals", "api", "component", "Approval engine", "Postgres tables, rules as data", "P1", "The heart. Works out who must approve from the amount, discount and document type, freezes a snapshot, and records every action.", { refs: ["Blueprint §3.3", "Pack p7–9"], nfr: ["route preview < 200 ms", "approve p95 < 300 ms"] });
  el("ap-defs", "approvals", "component", "Workflows & rules", "versioned", "P1", "Workflow definitions and threshold rules. A change applies only to new requests.", { changes: { P2: "Quote rules: Accountant → Finance; + Management above NPR 1,00,000 or discount > 12%; + Founder above NPR 10,00,000.", P3: "Invoice approval route.", P4: "Purchase request and vendor-bill payment routes." } });
  el("ap-route", "approvals", "component", "Router", null, "P1", "Turns a document into an ordered list of approval steps, with the reason for each.");
  el("ap-requests", "approvals", "component", "Requests & actions", "idempotency key · version check", "P1", "One request per submission, with a frozen snapshot. Approve, return (comment required) or reject.");
  el("ap-deleg", "approvals", "component", "Groups & delegation", null, "P1", "Approval groups (any one member) and dated delegations.");
  el("ap-sla", "approvals", "component", "Escalations", null, "P1", "Reminds at 24 h and escalates at 72 h (configurable).");

  el("verify", "api", "component", "Verification (KYB)", "manual checklist + evidence", "P2", "Proves a company is real before we trade with it. Stage 1 is a reviewer checklist with uploaded evidence, the reviewer's name and the date.", { refs: ["Blueprint §3.1a", "Meeting 4.10"], changes: { P4: "Adds vendors: PAN, registration and bank account, confirmed by a second person before the first payment." } });
  el("iv-cases", "verify", "component", "Verification cases", null, "P2", "One case per customer or vendor company, with a checklist and a status.");
  el("iv-evidence", "verify", "component", "Evidence", "PAN/VAT · registration · bank letter", "P2", "Uploaded documents, stored through Documents & evidence.");
  el("iv-maker", "verify", "component", "Second reviewer", "maker-checker", "P4", "A different person must confirm vendor bank details before activation or after any change.", { refs: ["Epics US-401"] });
  el("iv-adapter", "verify", "component", "Provider adapter", "IdVerificationAdapter", "P4", "Plug for an automated ID-check provider. Off by default.", { proposed: true });

  el("crm", "api", "component", "CRM", null, "P2", "Captures demand and turns it into qualified opportunities.", { refs: ["Blueprint §4.1", "Meeting 4.8 (Phase 1)"] });
  el("crm-leads", "crm", "component", "Leads", "duplicate check: email, phone, PAN, name", "P2", "Source and campaign, de-duplication, mandatory next action.");
  el("crm-opps", "crm", "component", "Opportunities", "pipeline stages", "P2", "New → Contacted → Qualified → … → Won / Lost (reason required).");
  el("crm-acts", "crm", "component", "Activities", null, "P2", "Calls, meetings, follow-ups.", { nfr: ["% active leads with a next action"] });
  el("crm-cust", "crm", "component", "Customers & contacts", null, "P2", "Created on conversion without duplicates.");

  el("quotes", "api", "component", "Quotations", null, "P2", "Versioned quotes that go through approval and are sent as frozen PDFs. Estimates merge in here (D3).", { refs: ["Blueprint §4.2", "D3"], nfr: ["0 self-approvals", "100% of controlled quotes routed correctly"] });
  el("q-versions", "quotes", "component", "Quotes & revisions", "Q-2026-001 Rev 2", "P2", "Immutable versions with a revision reason.");
  el("q-tmpl", "quotes", "component", "Templates & lines", "tax per line · NPR/INR/USD", "P2", "Merge variables, line items, quote-level discount.");
  el("q-submit", "quotes", "component", "Submit", null, "P2", "Sends the version to the approval engine with a frozen snapshot.");
  el("q-send", "quotes", "component", "Send", "frozen PDF", "P2", "Renders the PDF, stores it with its hash and emails the customer a portal link.");
  el("q-accept", "quotes", "component", "Acceptance", null, "P2", "Customer accepts or rejects with notes, optionally with a PO.");
  el("q-expiry", "quotes", "component", "Validity", "15 days default", "P2", "Expires quotes past their validity date.");

  el("salesmod", "api", "component", "Sales", "[definition needed]", "P3", "Our reading of \"Sales\" from the meeting: a sales order made from an accepted quote, with its payment schedule, so invoicing has something to bill against before Projects exist. Confirm with Rajendra (questions.md).", { proposed: true, refs: ["Meeting 4.8 (Phase 1: CRM, Quotations, Sales, Purchases, Invoicing)"] });
  el("s-orders", "salesmod", "component", "Sales orders", null, "P3", "Made from an accepted quote; carries the frozen prices.");
  el("s-evidence", "salesmod", "component", "Acceptance evidence", null, "P3", "Won only when the evidence rule is met: PO, signed quote or both.");
  el("s-sched", "salesmod", "component", "Payment schedule", "advance / balance", "P3", "Which amounts fall due when. Replaces milestone billing until Projects arrive.");

  el("billing", "api", "component", "Invoicing & payments", null, "P3", "Invoices from sales orders, payment proof, verification, allocation and receivables. Differs from the blueprint: no milestones or timesheets yet, so invoices come from the payment schedule.", { refs: ["Blueprint §4.5", "Meeting 4.8"], nfr: ["invoice ≤ 2 working days after it falls due"] });
  el("b-inv", "billing", "component", "Invoices", "Draft → Approved → Issued", "P3", "An issued invoice never changes. Duplicate billing is blocked.");
  el("b-notes", "billing", "component", "Credit & debit notes", null, "P3", "Linked to the original invoice.");
  el("b-proof", "billing", "component", "Payment proof", null, "P3", "Customer uploads a bank slip or screenshot.");
  el("b-verify", "billing", "component", "Verify & allocate", null, "P3", "Finance checks the money arrived, then spreads it across invoices; any excess becomes an advance.");
  el("b-ar", "billing", "component", "Receivables", "aging buckets · reminders", "P3", "Current, 1–15, 16–30, 31–60, 61–90, 90+ days.", { nfr: ["overdue AR value", "collection days"] });

  el("purch", "api", "component", "Purchases", null, "P4", "Spend with control: three quotes, approvals, POs and a three-way match.", { refs: ["Blueprint §4.6", "Meeting 4.8"], nfr: ["% of spend under an approved PO"] });
  el("pu-pr", "purch", "component", "Purchase requests", null, "P4", "Justification, cost centre, budget code.");
  el("pu-rfq", "purch", "component", "RFQ & comparison", "3 quotes by default", "P4", "Invites verified vendors, scores their quotes, or records a documented exception.");
  el("pu-po", "purch", "component", "Purchase orders", "amendments only", "P4", "Immutable once issued.");
  el("pu-grn", "purch", "component", "Receipts", "partial allowed", "P4", "What actually arrived.");
  el("pu-bill", "purch", "component", "Vendor bills", "3-way match", "P4", "PO vs receipt vs bill within tolerance, then payment approval.");
  el("pu-vendors", "purch", "component", "Vendors", null, "P4", "Vendor master and performance. Only verified vendors can be invited or paid.");

  // Workers
  el("workers", "bos", "worker", "Background workers", "BullMQ · same codebase", "P0", "Jobs that should not slow a request down. Same NestJS code, separate process.", { licence: "MIT" });
  el("w-outbox", "workers", "worker", "Outbox sender", null, "P1", "Sends what Notifications wrote. Retries 5 times over an hour, then dead-letter plus an alert.");
  el("w-sched", "workers", "worker", "Scheduler", "cron jobs", "P1", "Quote expiry, reminders, escalations.");
  el("w-scan", "workers", "worker", "Scanner", null, "P1", "Scans each upload and moves it from quarantine to clean.");
  el("w-pdf", "workers", "worker", "PDF renderer", null, "P2", "Renders quotes and invoices from HTML templates.", { nfr: ["PDF < 3 s"] });

  // Data
  el("data", "bos", "store", "Data", null, "P0", "Where state lives.");
  el("db", "data", "store", "Business database", "PostgreSQL 16", "P0", "Transactions, constraints, full-text search (pg_trgm). Row-level security later for SaaS.", { licence: "PostgreSQL", nfr: ["search < 300 ms"] });
  el("db-app", "db", "store", "Business tables", "Drizzle migrations", "P0", "Customers, quotes, orders, invoices, purchases, approvals. Money as numeric(18,2).");
  el("db-audit", "db", "store", "audit_events", "INSERT-only role", "P1", "Append-only; tampering breaks the hash chain.");
  el("db-outbox", "db", "store", "outbox", null, "P1", "Messages waiting to be sent.");
  el("valkey", "data", "store", "Job queue", "Valkey 9", "P0", "Queues for the background workers and the Workspace's server-side sessions.", { licence: "BSD-3" });
  el("files", "data", "store", "File store", "disk on ZFS mirror · quarantine/clean", "P1", "Private evidence, PDFs and uploads. Garage (S3) is the option if it outgrows one disk.");

  // Supporting services
  el("services", "bos", "container", "Supporting services", "Docker containers", "P1", "Open-source services we run beside the API.");
  el("clamav", "services", "container", "Malware scanner", "ClamAV", "P1", "Scans every upload before anyone can open it.", { licence: "GPL-2.0 (separate service)" });
  el("postal", "services", "container", "Mail server", "Postal", "P1", "Sends transactional mail and reports delivery and bounces.", { licence: "MIT" });
  el("gotenberg", "services", "container", "PDF engine", "Gotenberg", "P2", "HTML → PDF with a real browser engine.", { licence: "MIT" });

  // Operations
  el("ops", "bos", "container", "Operations", "Docker Compose · Ubuntu 24.04 VM on Proxmox", "P0", "Running it on one office PC, portable to a VPS later with no code change.", { refs: ["D5", "Meeting 4.13"], nfr: ["99.5% monthly", "RPO 15 min", "RTO 4 h"] });
  el("host", "ops", "container", "Office server", "Proxmox → Ubuntu 24.04 → Docker Compose", "P0", "The dedicated Linux box. Every container on this map runs here.");
  el("backup", "ops", "container", "Backups", "pgBackRest · restic", "P0", "Continuous WAL plus nightly full, encrypted offsite. Restore drill every month.", { licence: "MIT / BSD-2" });
  el("monitor", "ops", "container", "Monitoring", "Uptime Kuma · Beszel", "P0", "Checks from outside and server health; alerts within 5 minutes.", { licence: "MIT" });
  el("errors", "ops", "container", "Error tracking", "GlitchTip (Sentry-compatible)", "P1", "Every exception with its correlation id.", { licence: "MIT" });

  // Later
  el("later", null, "later", "Later (blueprint R2–R5)", "not in Stage 1", "P0", "Contracts and e-signature (Documenso/DocuSeal), projects, timesheets, change requests and UAT, inventory, HR and attendance (ZKTeco), leave and expenses, payroll, general ledger and VAT, multi-tenant SaaS with row-level security, workflow builder, PWA.", { refs: ["Blueprint §7"] });

  // ───────────────────────── Relations ─────────────────────────
  // Access
  rel("staff-admin", "tailscale", "admin from anywhere", "WireGuard", "P0");
  rel("tailscale", "host", "reaches the server", "SSH", "P0");
  rel("tailscale", "caddy", "private hostnames", "HTTPS", "P0");
  rel("public-ip", "caddy", "public hostnames", "HTTPS 443", "P2");
  rel("caddy", "ws-shell", "serves", "HTTP", "P0");
  rel("caddy", "cp-shell", "serves", "HTTP", "P2");
  rel("caddy", "vp-shell", "serves", "HTTP", "P4");
  rel("caddy", "z-loginui", "serves /ui/v2/login", "HTTP", "P0");
  rel("z-loginui", "z-login", "checks password / passkey", "gRPC (Connect)", "P0");
  rel("caddy", "z-oidc", "OIDC endpoints", "h2c", "P0");
  rel("caddy", "k-guard", "routes /api", "HTTP", "P0");
  rel("customer", "public-ip", "opens portal", "HTTPS", "P2");
  rel("vendor", "public-ip", "opens portal", "HTTPS", "P4");

  // People → screens
  rel("staff-admin", "ws-shell", "signs in", "browser", "P0");
  rel("staff-admin", "ws-admin", "sets roles & thresholds", "browser", "P1");
  rel("sales", "ws-crm", "works leads", "browser", "P2");
  rel("sales", "ws-quotes", "builds quotes", "browser", "P2");
  rel("sales", "ws-sales", "creates orders", "browser", "P3");
  rel("mgmt", "ws-inbox", "approves", "browser", "P2");
  rel("founder", "ws-inbox", "final approval", "browser + step-up", "P2");
  rel("finance", "ws-inbox", "reviews", "browser", "P2");
  rel("finance", "ws-review", "checks evidence", "browser", "P2");
  rel("finance", "ws-billing", "issues & verifies", "browser", "P3");
  rel("procurement", "ws-purch", "buys", "browser", "P4");
  rel("customer", "cp-quotes", "accepts quote", "browser", "P2");
  rel("customer", "cp-team", "manages team", "browser", "P2");
  rel("customer", "cp-invoices", "uploads payment proof", "browser", "P3");
  rel("vendor", "vp-onboard", "submits documents", "browser", "P4");
  rel("vendor", "vp-rfq", "quotes", "browser", "P4");
  rel("vendor", "vp-po", "submits bills", "browser", "P4");

  // Sign-in
  rel("ws-shell", "z-login", "redirects to login", "OIDC code + PKCE", "P0");
  rel("cp-shell", "z-login", "redirects to login", "OIDC code + PKCE", "P2");
  rel("vp-shell", "z-login", "redirects to login", "OIDC code + PKCE", "P4");
  rel("z-login", "z-oidc", "issues tokens", null, "P0");
  rel("z-bootstrap", "z-login", "first admin login", null, "P0", { until: "P1" });
  rel("z-oidc", "z-db", "users & sessions", "SQL", "P0");
  rel("z-org-staff", "z-db", "stored in", "SQL", "P0");
  rel("ws-shell", "k-guard", "calls API with token", "HTTPS/JSON", "P0");
  rel("cp-shell", "k-guard", "calls API with token", "HTTPS/JSON", "P2");
  rel("vp-shell", "k-guard", "calls API with token", "HTTPS/JSON", "P4");
  rel("k-guard", "z-oidc", "verifies signature", "JWKS", "P0");
  rel("k-guard", "k-authz", "who is this, what may they do", null, "P1");
  rel("k-authz", "db-app", "loads roles & scope", "SQL", "P1");
  rel("ws-admin", "z-org-staff", "invites staff", "ZITADEL API", "P1");
  rel("cp-team", "z-org-cust", "invites their users", "ZITADEL API", "P2");
  rel("z-login", "postal", "verify & reset emails", "SMTP", "P1");

  // Provisioning
  rel("cust-idp", "scim-ep", "pushes users & groups", "SCIM 2.0 + bearer", "P2");
  rel("scim-ep", "scim-map", "create / update", null, "P2");
  rel("scim-ep", "scim-deprov", "deactivate", null, "P2");
  rel("scim-map", "z-org-cust", "puts user in org", null, "P2");
  rel("scim-deprov", "z-login", "revokes sessions", null, "P2");
  rel("z-org-staff", "z-actions", "change events", null, "P1");
  rel("z-org-cust", "z-actions", "change events", null, "P2");
  rel("z-org-vendor", "z-actions", "change events", null, "P4");
  rel("z-actions", "k-users", "user/org changed", "signed webhook", "P1");
  rel("k-users", "db-app", "upserts users & memberships", "SQL", "P1");

  // Kernel plumbing
  rel("k-tenancy", "db-app", "scopes every query", "tenant_id, org_id", "P0");
  rel("k-audit", "db-audit", "appends", "SQL INSERT", "P1");
  rel("k-notify", "db-outbox", "writes in same transaction", "SQL", "P1");
  rel("k-config", "db-app", "locks number sequence", "SQL", "P1");
  rel("k-docs", "files", "writes to quarantine", "file I/O", "P1");
  rel("k-docs", "valkey", "queues scan", "BullMQ", "P1");
  rel("k-obs", "errors", "reports exceptions", "Sentry protocol", "P1");
  rel("monitor", "k-obs", "polls /health", "HTTPS", "P0");
  rel("monitor", "caddy", "checks from outside", "HTTPS", "P2");

  // Workers
  rel("w-scan", "valkey", "takes jobs", "BullMQ", "P1");
  rel("w-scan", "clamav", "scans file", "clamd TCP", "P1");
  rel("w-scan", "files", "moves to clean", "file I/O", "P1");
  rel("w-outbox", "db-outbox", "picks unsent", "SQL", "P1");
  rel("w-outbox", "postal", "hands over email", "Postal API", "P1");
  rel("postal", "smarthost", "relays", "SMTP + DKIM", "P1");
  rel("smarthost", "staff-admin", "delivers", "email", "P1");
  rel("smarthost", "mgmt", "approval emails", "email", "P2");
  rel("smarthost", "customer", "quote & invoice links", "email", "P2");
  rel("smarthost", "vendor", "invites & RFQs", "email", "P4");
  rel("w-pdf", "valkey", "takes jobs", "BullMQ", "P2");
  rel("w-pdf", "gotenberg", "HTML → PDF", "HTTP", "P2");
  rel("w-pdf", "files", "stores PDF + hash", "file I/O", "P2");
  rel("w-sched", "ap-sla", "ticks timers", null, "P1");
  rel("w-sched", "q-expiry", "daily expiry run", null, "P2");
  rel("w-sched", "b-ar", "reminder run", null, "P3");

  // Approvals
  rel("ws-inbox", "ap-requests", "approve / return / reject", "HTTPS/JSON", "P1");
  rel("ws-admin", "ap-defs", "edits thresholds", "HTTPS/JSON", "P1");
  rel("ap-requests", "ap-route", "computes route at submit", null, "P1");
  rel("ap-route", "ap-defs", "reads rule version", null, "P1");
  rel("ap-deleg", "ap-route", "applies delegations", null, "P1");
  rel("ap-requests", "k-authz", "no self-approval check", null, "P1");
  rel("ap-requests", "k-audit", "records every action", null, "P1");
  rel("ap-requests", "k-notify", "tells the next approver", null, "P1");
  rel("ap-sla", "ap-requests", "reminds 24 h, escalates 72 h", null, "P1");
  rel("ap-requests", "db-app", "requests, steps, actions", "SQL", "P1");

  // CRM & quotes
  rel("ws-crm", "crm-leads", "create / search", "HTTPS/JSON", "P2");
  rel("ws-crm", "crm-opps", "move stage", "HTTPS/JSON", "P2");
  rel("crm-leads", "crm-opps", "qualifies to", null, "P2");
  rel("crm-leads", "crm-cust", "converts to customer", null, "P2");
  rel("crm-acts", "crm-opps", "next action", null, "P2");
  rel("crm-cust", "db-app", "stores", "SQL", "P2");
  rel("crm-cust", "iv-cases", "opens company check", null, "P2");
  rel("crm-opps", "q-versions", "starts quotation", null, "P2");
  rel("ws-quotes", "q-versions", "edit draft", "HTTPS/JSON", "P2");
  rel("ws-quotes", "ap-route", "who will approve? (preview)", "HTTPS/JSON", "P2");
  rel("q-tmpl", "q-versions", "builds lines", null, "P2");
  rel("q-versions", "k-config", "number + FX snapshot", null, "P2");
  rel("q-versions", "q-submit", "submit", null, "P2");
  rel("q-submit", "ap-requests", "frozen snapshot", null, "P2");
  rel("ap-requests", "q-send", "approved → can send", null, "P2");
  rel("q-send", "valkey", "queues PDF", "BullMQ", "P2");
  rel("q-send", "k-notify", "emails portal link", null, "P2");
  rel("q-expiry", "q-versions", "marks expired", null, "P2");
  rel("cp-quotes", "q-accept", "accept / reject + PO", "HTTPS/JSON", "P2");
  rel("q-accept", "k-docs", "stores PO", null, "P2");
  rel("q-versions", "db-app", "stores versions", "SQL", "P2");

  // Verification
  rel("ws-review", "iv-cases", "approve / reject", "HTTPS/JSON", "P2");
  rel("iv-cases", "iv-evidence", "collects", null, "P2");
  rel("iv-evidence", "k-docs", "stores evidence", null, "P2");
  rel("iv-cases", "k-audit", "who checked, when", null, "P2");
  rel("iv-cases", "db-app", "stores", "SQL", "P2");
  rel("vp-onboard", "iv-evidence", "uploads documents", "HTTPS/JSON", "P4");
  rel("iv-cases", "iv-maker", "bank details → second reviewer", null, "P4");
  rel("iv-maker", "pu-vendors", "activates vendor", null, "P4");
  rel("iv-adapter", "idv", "document & selfie check", "HTTPS + HMAC webhook", "P4", { proposed: true });
  rel("iv-cases", "iv-adapter", "optional automated check", null, "P4");

  // Sales
  rel("q-accept", "s-orders", "accepted quote → order", null, "P3");
  rel("ws-sales", "s-orders", "create / confirm", "HTTPS/JSON", "P3");
  rel("s-evidence", "s-orders", "gates Won", null, "P3");
  rel("s-orders", "s-sched", "creates schedule", null, "P3");
  rel("s-orders", "db-app", "stores", "SQL", "P3");
  rel("s-sched", "b-inv", "amount due → draft invoice", null, "P3");

  // Billing
  rel("ws-billing", "b-inv", "review / issue", "HTTPS/JSON", "P3");
  rel("ws-billing", "b-verify", "verify payment", "HTTPS/JSON", "P3");
  rel("b-inv", "ap-requests", "Accountant → Finance", null, "P3");
  rel("b-inv", "k-config", "invoice number", null, "P3");
  rel("b-inv", "valkey", "queues PDF", "BullMQ", "P3");
  rel("b-inv", "k-notify", "invoice issued", null, "P3");
  rel("b-inv", "k-audit", "issue recorded", null, "P3");
  rel("b-inv", "db-app", "stores", "SQL", "P3");
  rel("b-notes", "b-inv", "adjusts", null, "P3");
  rel("cp-invoices", "b-proof", "uploads proof", "HTTPS/JSON", "P3");
  rel("b-proof", "k-docs", "scanned & stored", null, "P3");
  rel("b-proof", "b-verify", "waits for Finance", null, "P3");
  rel("b-verify", "b-ar", "allocates across invoices", null, "P3");
  rel("b-ar", "k-notify", "reminders", null, "P3");

  // Purchases
  rel("ws-purch", "pu-pr", "raise request", "HTTPS/JSON", "P4");
  rel("ws-purch", "pu-vendors", "invite vendor", "HTTPS/JSON", "P4");
  rel("ws-purch", "pu-rfq", "compare quotes", "HTTPS/JSON", "P4");
  rel("pu-vendors", "z-org-vendor", "creates vendor org + invite", "ZITADEL API", "P4");
  rel("pu-vendors", "iv-cases", "opens vendor check", null, "P4");
  rel("pu-vendors", "pu-rfq", "only verified vendors", null, "P4");
  rel("pu-pr", "ap-requests", "Dept Head → Accountant → Finance", null, "P4");
  rel("pu-pr", "pu-rfq", "approved → RFQ", null, "P4");
  rel("pu-rfq", "k-notify", "invites vendors", null, "P4");
  rel("vp-rfq", "pu-rfq", "submits quote", "HTTPS/JSON", "P4");
  rel("pu-rfq", "pu-po", "winner → PO", null, "P4");
  rel("pu-po", "pu-grn", "receive", null, "P4");
  rel("vp-po", "pu-bill", "submits bill", "HTTPS/JSON", "P4");
  rel("pu-grn", "pu-bill", "3-way match", null, "P4");
  rel("pu-bill", "ap-requests", "payment approval", null, "P4");
  rel("pu-po", "db-app", "stores", "SQL", "P4");

  // Ops
  rel("github", "host", "deploys images", "GHCR + compose pull", "P0");
  rel("backup", "db-app", "WAL + nightly", "pgBackRest", "P0");
  rel("backup", "z-db", "nightly", "pgBackRest", "P0");
  rel("backup", "files", "snapshots", "restic", "P1");
  rel("backup", "offsite", "encrypted copy", "S3", "P0");


  // ───────────────────────── Dev & measurement layers (hidden by default) ─────────────────────────
  const D = { layer: "dev" }, M = { layer: "measure" };
  el("z-loginui", "accounts", "component", "Login UI", "zitadel-login v4 (Next.js)", "P0", "ZITADEL's hosted login pages (Login V2), a second container beside the ZITADEL API.", { licence: "AGPL-3.0 (unmodified)" });
  el("mailpit", "bos", "container", "Dev mail catcher", "Mailpit", "P0", "Catches every email in development and shows it at mail.localhost. Nothing reaches real inboxes. Replaced by Postal + relay in production.", Object.assign({ licence: "MIT" }, D));
  el("d-personas", "workspace", "component", "Persona switcher", "/dev/personas (dev build only)", "P0", "Lists seeded test users (Founder, Management, Finance, Sales, Customer, Vendor) and logs in as one through the real ZITADEL login. No bypass in the API; a build check proves it is absent from production.", Object.assign({ refs: ["ADR 0009"] }, D));
  el("d-seed", null, "worker", "ZITADEL seed tool", "pnpm seed (idempotent)", "P0", "Creates the project, roles, OIDC app, dev orgs, six personas and the load-test machine user, and writes .dev/ files.", D);
  el("d-ci", null, "external", "CI checks", "GitHub Actions", "P0", "Typecheck, lint, unit, database and API end-to-end tests, web build with the no-switcher check, image builds. Required to merge.", Object.assign({ refs: ["ADR 0016"] }, D));
  el("m-metrics", "kernel", "component", "Latency metrics", "prom-client · /metrics (internal port)", "P0", "A histogram per route (http_server_request_duration_seconds) with buckets on the target edges 0.3 s / 0.5 s / 0.8 s, plus LCP from real browsers.", Object.assign({ licence: "Apache-2.0", nfr: ["reads p95 < 300 ms", "writes p95 < 500 ms"], refs: ["ADR 0010"] }, M));
  el("m-telemetry", "api", "component", "Vitals intake", "POST /v1/telemetry/vitals", "P0", "Receives page-speed numbers (LCP etc.) from the Workspace and records them.", M);
  el("m-vitals", "workspace", "component", "Web vitals reporter", "next/web-vitals", "P0", "Measures how fast each page really loads in the user's browser and reports it.", Object.assign({ nfr: ["LCP < 1.5 s on LAN"] }, M));
  el("m-prom", "ops", "container", "Prometheus", "optional obs profile", "P0", "Scrapes /metrics so the histograms can be graphed. Not needed for the gates.", Object.assign({ licence: "Apache-2.0" }, M));
  el("m-k6", null, "external", "Load tests", "k6 (thresholds = NFR table)", "P0", "Pretends to be 50 users; fails the run (exit 99) if p95 or error-rate targets are missed. Exit gate for every phase.", Object.assign({ licence: "AGPL-3.0 (separate tool)", refs: ["ADR 0011"] }, M));
  el("m-playwright", null, "external", "Browser tests", "Playwright", "P0", "Signs in as every persona through the real login, checks the production build has no switcher, and asserts LCP < 1.5 s.", Object.assign({ licence: "Apache-2.0" }, M));

  rel("staff-admin", "d-personas", "picks a persona", "browser", "P0", D);
  rel("d-personas", "z-loginui", "login_hint + prompt=login", "OIDC", "P0", D);
  rel("d-seed", "z-org-staff", "creates project, app, personas", "ZITADEL API", "P0", D);
  rel("d-seed", "z-org-cust", "creates Dev Customer Co", "ZITADEL API", "P2", D);
  rel("d-seed", "z-org-vendor", "creates Dev Vendor Co", "ZITADEL API", "P4", D);
  rel("d-seed", "db-app", "org rows", "SQL", "P0", D);
  rel("z-loginui", "mailpit", "dev emails", "SMTP", "P0", D);
  rel("w-outbox", "mailpit", "dev emails", "SMTP", "P1", D);
  rel("github", "d-ci", "runs on every push", null, "P0", D);
  rel("k-obs", "m-metrics", "records latency per route", null, "P0", M);
  rel("m-vitals", "m-telemetry", "LCP, INP, CLS", "HTTPS via Workspace", "P0", M);
  rel("m-telemetry", "m-metrics", "LCP histogram", null, "P0", M);
  rel("m-prom", "m-metrics", "scrapes", "HTTP", "P0", M);
  rel("m-k6", "caddy", "50 users, p95 gates", "HTTPS", "P0", M);
  rel("m-playwright", "caddy", "persona logins, LCP", "HTTPS", "P0", M);

  // ───────────────────────── Flows ─────────────────────────
  const F = [
    { id: "signin", name: "Staff sign-in", since: "P1", desc: "Passkey login, then the first API call with permission checks.", steps: [
      ["staff-admin", "ws-shell", "Opens the Workspace"],
      ["ws-shell", "z-login", "Redirected to ZITADEL: passkey or password + TOTP"],
      ["z-login", "z-oidc", "Login OK: ID and access tokens issued"],
      ["ws-shell", "k-guard", "API call carries the access token"],
      ["k-guard", "z-oidc", "Signature checked against cached JWKS"],
      ["k-guard", "k-authz", "Role, permissions and record scope loaded"],
      ["k-authz", "db-app", "Only rows in your scope come back"],
    ] },
    { id: "scim", name: "Customer users via SCIM", since: "P2", desc: "A customer's directory creates and removes their users here.", steps: [
      ["cust-idp", "scim-ep", "Customer's Entra ID sends POST /Users"],
      ["scim-ep", "scim-map", "User created"],
      ["scim-map", "z-org-cust", "Placed in that customer's org with a default role"],
      ["z-org-cust", "z-actions", "ZITADEL emits user.added"],
      ["z-actions", "k-users", "Signed webhook to the API"],
      ["k-users", "db-app", "Local user + membership saved"],
      ["cust-idp", "scim-ep", "Later: PATCH active=false"],
      ["scim-ep", "scim-deprov", "Deactivate"],
      ["scim-deprov", "z-login", "Sessions revoked at once"],
    ] },
    { id: "lead2quote", name: "Lead to accepted quote", since: "P2", desc: "Lead → opportunity → quote → approval → frozen PDF → customer accepts.", steps: [
      ["sales", "ws-crm", "Sales logs a new lead"],
      ["ws-crm", "crm-leads", "Duplicate check by email, phone, PAN"],
      ["crm-leads", "crm-opps", "Qualified → opportunity"],
      ["crm-opps", "q-versions", "Quotation Q-2026-014 Rev 1 drafted"],
      ["ws-quotes", "ap-route", "Preview: NPR 4,50,000 and 15% discount → Accountant, Finance, Management"],
      ["q-versions", "q-submit", "Submitted"],
      ["q-submit", "ap-requests", "Request created with a frozen snapshot"],
      ["ap-requests", "k-authz", "Creator removed from approvers (no self-approval)"],
      ["ap-requests", "k-notify", "Next approver notified"],
      ["k-notify", "db-outbox", "Message written in the same transaction"],
      ["w-outbox", "postal", "Outbox sender hands it to Postal"],
      ["postal", "smarthost", "Relayed with DKIM"],
      ["smarthost", "mgmt", "Management gets the approval email"],
      ["mgmt", "ws-inbox", "Opens the inbox and approves"],
      ["ws-inbox", "ap-requests", "Last step approved; action audited"],
      ["ap-requests", "q-send", "Quote unlocked for sending"],
      ["q-send", "valkey", "PDF job queued"],
      ["w-pdf", "gotenberg", "HTML template → PDF"],
      ["w-pdf", "files", "PDF stored with its SHA-256"],
      ["smarthost", "customer", "Customer gets a portal link (no attachment)"],
      ["customer", "cp-quotes", "Opens the frozen quote"],
      ["cp-quotes", "q-accept", "Accepts and uploads a PO"],
    ] },
    { id: "order2cash", name: "Order to cash", since: "P3", desc: "Accepted quote → sales order → invoice → payment proof → verified and allocated.", steps: [
      ["q-accept", "s-orders", "Accepted quote becomes a sales order"],
      ["s-orders", "s-sched", "Schedule: 60% advance, 40% on delivery"],
      ["s-sched", "b-inv", "Advance falls due → draft invoice"],
      ["b-inv", "ap-requests", "Accountant → Finance approve"],
      ["b-inv", "k-config", "Gap-free invoice number assigned on issue"],
      ["b-inv", "valkey", "PDF queued; invoice now immutable"],
      ["b-inv", "k-notify", "Customer told the invoice is ready"],
      ["customer", "cp-invoices", "Customer pays and opens the portal"],
      ["cp-invoices", "b-proof", "Uploads the bank slip"],
      ["b-proof", "k-docs", "Slip goes to quarantine"],
      ["w-scan", "clamav", "Scanned, then moved to clean"],
      ["finance", "ws-billing", "Finance sees it in the queue"],
      ["ws-billing", "b-verify", "Confirms money in the bank"],
      ["b-verify", "b-ar", "Allocated; invoice Paid, AR updated"],
    ] },
    { id: "vendor-kyb", name: "Vendor onboarding & verification", since: "P4", desc: "Invite a vendor, collect evidence, two-person bank check, activate.", steps: [
      ["procurement", "ws-purch", "Procurement adds a new vendor"],
      ["ws-purch", "pu-vendors", "Vendor record created (inactive)"],
      ["pu-vendors", "z-org-vendor", "Vendor org created; invite sent"],
      ["smarthost", "vendor", "Vendor gets the invite"],
      ["vendor", "vp-onboard", "Signs up and fills company details"],
      ["vp-onboard", "iv-evidence", "Uploads PAN, registration, bank letter"],
      ["iv-evidence", "k-docs", "Evidence scanned and stored"],
      ["finance", "ws-review", "Finance reviewer opens the case"],
      ["ws-review", "iv-cases", "Checklist ticked, reviewer + date recorded"],
      ["iv-cases", "iv-maker", "Bank details need a second person"],
      ["iv-maker", "pu-vendors", "Second reviewer confirms → vendor active"],
    ] },
    { id: "p2p", name: "Request to vendor bill", since: "P4", desc: "Purchase request → RFQ with three quotes → PO → receipt → bill → payment approval.", steps: [
      ["procurement", "ws-purch", "Raises a purchase request"],
      ["ws-purch", "pu-pr", "Justification and budget code"],
      ["pu-pr", "ap-requests", "Dept Head → Accountant → Finance"],
      ["pu-pr", "pu-rfq", "Approved → RFQ"],
      ["pu-vendors", "pu-rfq", "Only verified vendors can be invited"],
      ["pu-rfq", "k-notify", "Three vendors invited"],
      ["vendor", "vp-rfq", "Vendor prepares a quote"],
      ["vp-rfq", "pu-rfq", "Quotes compared and scored"],
      ["pu-rfq", "pu-po", "Winner → purchase order"],
      ["pu-po", "pu-grn", "Goods arrive (partial receipt)"],
      ["vp-po", "pu-bill", "Vendor submits the bill"],
      ["pu-grn", "pu-bill", "PO vs receipt vs bill match"],
      ["pu-bill", "ap-requests", "Payment approval"],
    ] },
    { id: "backup", name: "Backup & restore drill", since: "P0", desc: "How data survives the office PC dying.", steps: [
      ["backup", "db-app", "WAL streamed continuously, full backup nightly"],
      ["backup", "z-db", "Accounts database too"],
      ["backup", "offsite", "Encrypted copy leaves the building"],
      ["monitor", "k-obs", "Monitoring alerts if a backup or the API fails"],
    ] },
    { id: "dev-persona", name: "Dev: switch persona", since: "P0", layer: "dev", desc: "Log in as any seeded test user through the real login, so every role's flow can be checked quickly.", steps: [
      ["staff-admin", "d-personas", "Open /dev/personas (dev build only)"],
      ["d-personas", "z-loginui", "Choose \"Finance\": login opens with that user filled in"],
      ["z-loginui", "z-login", "Real password check"],
      ["z-login", "z-oidc", "Real tokens issued"],
      ["ws-shell", "k-guard", "API checks the token exactly as in production"],
    ] },
    { id: "measure-gate", name: "Measure: load-test gate", since: "P0", layer: "measure", desc: "How a phase proves it meets the speed targets before it ships.", steps: [
      ["m-k6", "caddy", "k6 runs 50 virtual users for 3 minutes"],
      ["caddy", "k-guard", "Every request is a real, signed call"],
      ["k-guard", "z-oidc", "Token checked against cached keys"],
      ["k-obs", "m-metrics", "Each response time lands in a histogram bucket"],
      ["m-prom", "m-metrics", "Optional: Prometheus graphs it"],
      ["m-k6", "caddy", "p95 over 300 ms? The run exits 99 and the phase is not done"],
    ] },
    { id: "measure-lcp", name: "Measure: page speed (LCP)", since: "P0", layer: "measure", desc: "Real page-load numbers from browsers.", steps: [
      ["m-vitals", "m-telemetry", "Browser reports LCP after the page settles"],
      ["m-telemetry", "m-metrics", "Recorded per route"],
      ["m-playwright", "caddy", "CI also asserts LCP < 1.5 s on the signed-in shell"],
    ] },
  ].map((f) => ({ id: f.id, name: f.name, since: f.since, layer: f.layer, desc: f.desc, steps: f.steps.map(([src, dst, note]) => ({ src, dst, note })) }));

  window.BOS_MODEL = {
    meta: {
      title: "Business OS · System map",
      subtitle: "Stage 1 (first 3 months), phase by phase. Click a box to expand it.",
      updated: "2026-11-08",
    },
    phases: [
      { id: "P0", name: "Ground floor", weeks: "Weeks 1–2 (proposed)", goal: "The office server, the pipes and staff login: ZITADEL, API and Workspace shells, database, queue, backups, monitoring, CI.", exit: "Admin logs in through ZITADEL over Tailscale; /health is green; a restore drill passes." },
      { id: "P1", name: "Platform kernel", weeks: "Weeks 3–4 (proposed)", goal: "The six platform services: permissions and scope, approval engine, documents, notifications, audit, settings and numbering. MFA enforced.", exit: "A test document goes through a two-step approval with no self-approval, an email, a scanned upload and a full audit trail." },
      { id: "P2", name: "CRM & quotations", weeks: "Weeks 5–8 (proposed)", goal: "Leads to accepted quotes. Customers get their own org, the client portal goes public, customer companies are verified.", exit: "Lead → quote → dynamic approval → frozen PDF → customer accepts in the portal, with zero self-approvals and full audit." },
      { id: "P3", name: "Sales & invoicing", weeks: "Weeks 8–10 (proposed)", goal: "Sales orders from accepted quotes, invoices from the payment schedule, payment proof verified and allocated.", exit: "Accepted quote → order → invoice → proof → verified allocation; customers see only their own invoices." },
      { id: "P4", name: "Purchases & vendor accounts", weeks: "Weeks 10–12 (proposed)", goal: "Vendor accounts with ID verification, purchase requests, three quotes, POs, receipts and bills. Stage 1 complete.", exit: "Verified vendor → PR → RFQ → PO → receipt → bill → payment approval; an unverified vendor cannot be invited or paid.", target: true },
    ],
    elements: E,
    relations: R,
    flows: F,
  };
})();

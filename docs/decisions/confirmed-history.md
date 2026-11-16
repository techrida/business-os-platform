# Business OS decisions answered by Kuu

This file records the answers from the decision deck (74 questions in all). Each entry gives the answer and what it changes in the build.

## 2026-11-09: D01–D12 (Kuu)

| # | Question | Answer | Effect on the build |
|---|---|---|---|
| D01 | Organization: legal entity or login org? | A: legal entity | ADR 0027 is already accepted. P3 and P4 follow it. |
| D02 | Approval-limit basis | A: grand total incl. VAT, in NPR, before TDS, strict `>` | `money-rules` `amountNpr`. P3 A3 and P4 AD3. |
| D03 | New roles plus a department-head step | A, with a refinement. Kuu was unsure because these roles are not all in the spec. | Department-head and line-manager steps are added as step kinds (BRD:256, 262, 268). PMO folds into `project_manager` (CPD:196). `operations_officer` is added (CPD:190). Operations Head approves stock adjustments (THR:489). Procurement is a role. **Receiver is dropped**: goods receipt goes to a `warehouse` role (Warehouse/Operations in the spec). Evidence: `deck/notes-part1.md:396`. |
| D04 | Number calendar | A: BS fiscal year everywhere | Kernel `NumberingService`. P3 A2. |
| D05 | Founder's own purchase above NPR 10,00,000 | A: two distinct Management approvers | P4 AD8. |
| D06 | Founder threshold | A: above NPR 10,00,000 | P4 AD4 bands. |
| D07 | Second person for workflow publishes and privileged role grants | B: publishes only | Workflow publish keeps maker-checker. Privileged role grants are single-person, but still audited. |
| D08 | Offsite backups | C: a second Techrida site | ADR 0015 follow-up: the pgBackRest repo2 target is the second site. |
| D09 | FX policy | A: mid rate, Finance-only manual entry, max 7 days | The P2 staleness setting is 7 days. P3 issue refuses a stale rate (409). |
| D10 | Performance, recovery and uptime targets | A: the team's targets | ADR 0011 gates stand. |
| D11 | ZITADEL self-registration | A: closed, invite only | `PORTAL_LOGIN_POLICY.allowRegister=false`, already built. |
| D12 | Job queue | A: keep BullMQ on Valkey | No change. |

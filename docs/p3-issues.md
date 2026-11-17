# P3 study issues and decisions

## Resolved

- D15: Sales means sales orders with a billing schedule. Planning question Q28 is closed by this scope answer plus retirement of its obsolete schedule question D16. Verify the existing behavior rather than rebuilding it.
- D18 inherited: a signed quote is the default Won evidence; verify the same evidence policy at sales-order confirmation.

## Clarify at P3, not during P0

- D19: P3-BUILD-PLAN A5 specifies Accountant → Finance for invoice, credit-note and debit-note approval; empty routes refuse submission. A3's money comparison rule does not itself add Management/Founder steps to invoices. Explain the distinction from purchase commitments and matched/non-PO payment routes. Kuu asked whether the plan already covers this; no choice or threshold change was confirmed.

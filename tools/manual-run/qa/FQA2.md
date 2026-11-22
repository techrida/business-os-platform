# FQA2 (final QA part 2): tools

Development and test tooling only. Evidence goes to `/home/crestia/bos-runtimes/round5/evidence/FQA2/` (`FQA_EVIDENCE` overrides it).

| File                                        | What                                                                                                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fqa2.mjs`                                  | `node tools/manual-run/qa/fqa2.mjs --sizes desktop,laptop,tablet,mobile [--only area-flow,...]` runs the recorded flows, one clip per flow per size under `clips/`                                                                              |
| `fqa2-flows.mjs`                            | the flows: payments re-record (FX5 review dialog, focus), parties (customer, lead, vendor, company profile, CSV import, country picker), sales (discount pair, deal lost), users, portal (customer, vendor), documents (PDF address and phones) |
| `fqa2-report.mjs`                           | builds `index.html` and `results.md` from `results.json`, issues, fixture and notes                                                                                                                                                             |
| `fqa2-fixture.sh`, `fqa2-confirm-order.mjs` | Job 0, the portal fixture (see `evidence/FQA2/fixture.md`)                                                                                                                                                                                      |
| `fqa1-lib.mjs`, `fqa1-flows.mjs`            | the part-1 library and helpers (`runSize`, `goNav`, `search`, `proofFile`)                                                                                                                                                                      |

Setup: `source /home/crestia/bos-runtimes/round5/qa-env.sh` (Node 24, `PERSONAS_FILE`). Passwords are read in code and masked in clips; the portal sign-in is the real ZITADEL flow.
The lost-deal flow needs one deal with a Sent quotation per size, made with `sales.mjs` (`--only sales-1..sales-8`, a new label each, no `SALES_EXISTING_CUSTOMER`); the label to use per size is in `LOST_LABEL` in `fqa2-flows.mjs`.

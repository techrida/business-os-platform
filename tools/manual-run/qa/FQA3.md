# FQA3 (final QA re-record): tools

Evidence: `/home/crestia/bos-runtimes/round5/evidence/FQA3/` (`FQA_EVIDENCE` overrides it).

| File              | What                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fqa3.mjs`        | `node tools/manual-run/qa/fqa3.mjs --sizes desktop,laptop,tablet,mobile [--only area-flow,...]`; one clip per flow per size. A flow name is unique: FQA3 flows, then the FQA2 flows, then the FQA1 flows                        |
| `fqa3-flows.mjs`  | new flows: dev-chip-settings, procurement-line-widths (adds 1100 px at laptop), focus-date-picker-label, deal-lost-refusals-portal (needs one Sent Dev Customer Co deal per size, label in `LOST_LABEL`), portal-compiled-build |
| `fqa3-report.mjs` | builds `index.html` and `results.md` from `results.json`                                                                                                                                                                        |

Notes: run lanes in parallel, but run procurement workflows one at a time (the PO baseline is a list diff, so lanes see each other's orders). Sign-ins as one persona claim the one-time-code window across processes (`lib/totp.mjs` `claimCode`). `results.json` can drop rows under concurrent lanes; the lane logs are the record.

# Quarantined QA specs

`quarantine.txt` is one regular expression of test titles. The `qa specs` shards skip those tests; the non-blocking
`qa quarantined` job runs them so their result and videos stay visible. Remove a title once its spec passes. An empty
file means nothing is quarantined: the shards skip nothing extra and the quarantined job exits at once.

Nothing is quarantined now (R6Q5). The three that were (`p4/line-item-widths`: receipt, RFQ quotation entry, bill entry)
had no data to open: `.github/qa/demo-data.sql` now holds an approved purchase request with an open RFQ that invites the
dev vendor, and a purchase order that the `qa fixtures` Playwright step issues through the screen. The bill form is
measured through the order's "Enter bill" link, because the bare `/payables/bills/new` route shows no line items until
an order is picked.

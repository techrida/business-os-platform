# Quarantined QA specs

`quarantine.txt` is one regular expression of test titles. The `qa specs` shards skip those tests; the non-blocking
`qa quarantined` job runs them so their result and videos stay visible. Remove a title once its spec passes.

| Spec                                                | Why it fails today                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p4/line-item-widths`: receipt, RFQ quotation entry | They open the first purchase order and RFQ on a list page and follow the receipt or quotation link. The seed holds no purchase order or RFQ, so the lists are empty. Fix: a fixture that raises a purchase request, an RFQ and a purchase order (procurement then Founder approvals), or create them in the spec. |
| `p4/line-item-widths`: `/payables/bills/new`        | The form shows no line-item number boxes at 390 px (found 0, expected at least 2) on a fresh stack. Probably it needs a vendor or an order picked first; the spec measures the bare route. Needs a decision on what the bare route should show.                                                                   |

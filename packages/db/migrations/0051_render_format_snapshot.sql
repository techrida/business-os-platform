-- 0051_render_format_snapshot: an invoice copy prints with the number grouping and date pattern of its first print.
--
-- An issued invoice is frozen, but how its numbers and dates are written comes from settings (D30, D27). The first
-- print stores that format on its print-log row; a later copy ("Copy of original (2)") reads it back instead of the
-- settings in force on the day of the reprint.
--   * Nullable jsonb, no default: prints made before this migration hold NULL and a copy of them uses the settings
--     in force when it is printed, as before.
--   * The print log is append-only (UPDATE and DELETE are refused by its trigger); this column is only ever written
--     by the INSERT of the print, so no trigger or grant changes.
--   * Purchase orders need no column: a delivered purchase-order PDF is never rendered again.

ALTER TABLE "app"."invoice_print_log" ADD COLUMN "render_format" jsonb;

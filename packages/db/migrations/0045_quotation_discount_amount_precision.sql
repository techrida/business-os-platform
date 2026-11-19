-- The column also carries percentages, so keep four places and constrain amount values.
-- Block concurrent edits while checking and converting existing rows.
LOCK TABLE app.quotation_versions IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  frozen_count bigint;
  changed_count bigint;
BEGIN
  SELECT count(*) INTO frozen_count
  FROM app.quotation_versions
  WHERE discount_mode = 'amount' AND discount_input <> round(discount_input, 2)
    AND status NOT IN ('draft', 'returned');

  -- Frozen content includes this field in its approval hash. The application has always
  -- rejected excess amount precision. If a historical record bypassed it, stop for an
  -- explicit repair instead of invalidating approval evidence.
  IF frozen_count <> 0 THEN
    RAISE EXCEPTION '0045: % frozen quotation versions need audited discount repair', frozen_count;
  END IF;

  PERFORM set_config('bos.actor_kind', 'system', true);
  PERFORM set_config('bos.actor_id', 'system:migration-0045', true);
  PERFORM set_config('bos.correlation_id', 'migration-0045:' || gen_random_uuid()::text, true);
  PERFORM set_config('bos.ip', '', true);
  PERFORM set_config('bos.user_agent', '', true);

  UPDATE app.quotation_versions
  SET discount_input = round(discount_input, 2)
  WHERE discount_mode = 'amount' AND discount_input <> round(discount_input, 2);
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RAISE NOTICE '0045: rounded % quotation amount discounts', changed_count;
END;
$$;
--> statement-breakpoint
ALTER TABLE app.quotation_versions
  ADD CONSTRAINT quotation_versions_amount_discount_precision_check
  CHECK (discount_mode <> 'amount' OR discount_input = round(discount_input, 2));

-- Key control, enforced by the database as well as by the commands (D-19, D-73, AT-035).
--
--  * A retired item stays retired (retire is the end of an item's life; a new key is a new row).
--  * A damaged item leaves "damaged" only by being retired or replaced: it is never returned to the cabinet and never issued again.
--  * A lost item leaves "lost" to the cabinet or back to its holder ONLY as "found": the command announces it with the
--    transaction-local setting gh.item_found = <item id>. Any other path (a "return" of a lost key, a bulk update, a clearance step)
--    is refused here with the state-transition error GH001.
--  * One holder at a time: an issued item cannot move from one holder to another in a single step; it is returned first.
--
-- These rules hold whatever code writes the row, including future stages.
CREATE FUNCTION handover_item_exit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'A retired key or asset stays retired (%)', OLD.code
      USING ERRCODE = 'GH001', HINT = 'Add a new item instead';
  END IF;
  IF OLD.status = 'damaged' AND NEW.status IN ('in_cabinet', 'issued') THEN
    RAISE EXCEPTION 'A damaged key or asset is never returned or issued again (%)', OLD.code
      USING ERRCODE = 'GH001', HINT = 'Retire it, or replace it with a new one';
  END IF;
  IF OLD.status = 'lost' AND NEW.status IN ('in_cabinet', 'issued')
     AND coalesce(current_setting('gh.item_found', true), '') <> NEW.id::text THEN
    RAISE EXCEPTION 'A lost key or asset is never marked returned (%)', OLD.code
      USING ERRCODE = 'GH001', HINT = 'Mark it found, or retire or replace it';
  END IF;
  IF OLD.status = 'issued' AND NEW.status = 'issued' AND OLD.holder_staff_id IS DISTINCT FROM NEW.holder_staff_id THEN
    RAISE EXCEPTION 'A key or asset has one holder at a time (%)', OLD.code
      USING ERRCODE = 'GH001', HINT = 'Record the return first, then issue it';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER handover_item_exit_guard BEFORE UPDATE OF status, holder_staff_id ON handover_item
  FOR EACH ROW EXECUTE FUNCTION handover_item_exit_guard();

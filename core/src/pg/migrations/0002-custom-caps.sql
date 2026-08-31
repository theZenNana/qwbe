-- The custom-value caps exist in the DATABASE too, not only in the application
-- (QWB-54 ticket 05, defect 2). The application checks the caps on every write; this
-- function backs the CHECK constraint every cube table carries (see ensureTable in
-- pg/setup.ts), so the limit holds even when the application is absent or broken.
--
-- jsonb_object_keys is a set-returning function, and a CHECK constraint cannot contain a
-- subquery -- but it can call an IMMUTABLE function that runs one. The key count of a given
-- jsonb value never changes, so IMMUTABLE is honest.
CREATE OR REPLACE FUNCTION qwbe.custom_key_count(value jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE AS $func$
  SELECT count(*)::integer FROM jsonb_object_keys(value)
$func$;

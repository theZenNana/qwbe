-- The kernel activity log (Echo stage A1). One row per committed row mutation of a declared
-- entity cube, written in the SAME transaction as the mutation (pg/store.ts), so "changed"
-- and "recorded" cannot disagree -- a rolled-back write rolls its activity row back with it.
--
-- Separate from qwbe.outbox on purpose: the outbox is the relay cursor reserved by ADR-0001
-- section 5 and is INSERT-only for cube roles (probes/store-isolation.mjs). Activity needs
-- SELECT, and exactly one cube role (the manifest declaring `readsActivity`) gets it; every
-- cube role gets INSERT + sequence USAGE next to its outbox grants (pg/setup.ts).
--
-- No actor of a new kind: `actor_id`/`actor_username` are the authenticated account, or NULL
-- for a write with no authenticated request (boot, migration, CLI-only paths).
--
-- `changes` shape: create -> { "<field>": { "to": <value> } }; update -> { "from", "to" } for
-- changed keys only (`custom` diffed per sub-key as `custom.<name>`); delete -> {} (values of
-- deleted rows are withheld; they remain visible in earlier update rows to those allowed).
-- `comment_id` is reserved for the later echo-cube comment events (stage A2).
CREATE TABLE IF NOT EXISTS qwbe.activity (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  cube text NOT NULL,
  entity_type text NOT NULL,
  row_id text NOT NULL,
  op text NOT NULL,
  version integer,
  actor_id text,
  actor_username text,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  comment_id text
);
CREATE INDEX IF NOT EXISTS activity_target ON qwbe.activity (cube, row_id, id DESC);
CREATE INDEX IF NOT EXISTS activity_cube ON qwbe.activity (cube, id DESC);

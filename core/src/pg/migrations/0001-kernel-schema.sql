-- The kernel's own schema: migration records and the outbox (ADR-0001 sections 4 and 5).
-- Nothing else lives here, and the cube roles get INSERT on the outbox and nothing more.
CREATE SCHEMA IF NOT EXISTS qwbe;

CREATE TABLE IF NOT EXISTS qwbe.migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qwbe.outbox (
  id bigserial PRIMARY KEY,
  cube text NOT NULL,
  "table" text NOT NULL,
  row_id text NOT NULL,
  op text NOT NULL,
  version integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

-- The whole point of the role-per-cube design is that grants are the boundary. A schema the
-- setup forgot to lock down would be readable by every connection, silently -- the one failure
-- mode nothing in the code will report. Start from nothing, grant upwards.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

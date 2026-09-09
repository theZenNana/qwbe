-- The comment table (Echo A2, comments slice). The body lives HERE only: the activity log
-- never carries comment text, so no history of the log can leak an old body.
--
-- Linked to the log one-to-one: the comment's activity row (op = 'comment') stores this id in
-- qwbe.activity.comment_id; the comment row and the activity row are written in ONE
-- transaction (pg/activity.ts comments.add) or not at all.
--
-- Deletion is in-place: body is wiped to '' and the deleted_at/deleted_by markers are set.
-- The activity row stays (the feed renders "comment deleted"); there is no comment-body
-- history anywhere.
--
-- Target columns are denormalized so edit/delete can re-check the CURRENT target gates
-- (capture entity, read route, summary, entity edit) without joining through the log, and so
-- a stale comment can never be edited against a target that has since changed identity.
CREATE TABLE IF NOT EXISTS qwbe.comment (
  id text PRIMARY KEY,
  cube text NOT NULL,
  entity_type text NOT NULL,
  row_id text NOT NULL,
  actor_id text,
  actor_username text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by text
);

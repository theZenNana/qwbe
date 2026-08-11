# Runtime hierarchy: Booktags as parent cube

**Date:** 2026-08-11
**Ticket:** IDE-18 / Kaneo `z3vjri0cl8fue1jidst9sd4z`
**Status:** design for owner approval -- the ticket forbids implementation before this is approved.
**Basis:** `~/Projects/wiki/qwbe/DIRECTION.md` section 2 (applications that contain their own modules),
which recommends exactly one level of nesting and compound names built on the existing prefix
mechanism.

This document answers the ten design questions from the ticket, then states the invariants.

---

## 0. Shape on disk

```
core/plugins/example-plugin/cubes/booktags/
    index.ts            the parent cube (screen, namespace root, no tables)
    bookmarks/index.ts  child cube, identity "booktags/bookmarks"
    tags/index.ts       child cube, identity "booktags/tags"
    settings/index.ts   child cube, identity "booktags/settings"
```

A child is a cube directory nested inside a parent cube directory. That is the entire
mechanism -- the invariant survives unchanged: **installing Booktags is copying one directory;
nothing existing is edited.** Discovery is recursive one level deep. `notes` is untouched and
remains the canonical standalone cube.

## 1. Identity and addressing

A child's full name is `<parent>/<child>`: `booktags/bookmarks`, `booktags/tags`,
`booktags/settings`. The parent is `booktags`.

The slash is the namespace separator, the same way `:` is the separator between cube and
permission. `NAME_PATTERN` is extended: a name is one or two segments of the existing slug
pattern joined by `/`. Two segments maximum -- DIRECTION.md section 2.4 recommends exactly one level
until a real case demands the second, and nothing here does.

The manifest of a child declares `parent: "booktags"`; the kernel checks the declaration
against the real directory layout, exactly as it already checks `name` against the directory
name. A manifest cannot lie about who owns it.

## 2. Namespaces

| Surface | Rule |
|---|---|
| Permissions | child's prefix is its full name: `booktags/bookmarks:read`. The existing rule "prefix must be the cube name" already covers this once the name is compound. |
| Commands | `booktags/bookmarks:count`. The dispatcher splits on `:` for the owning cube -- unchanged. |
| Events | `booktags/bookmarks.created` -- declared in `publishes`, visible in the catalogue, unchanged. |
| Tables | owned per child exactly as today; `checkUniqueTables` unchanged. One SQLite file per cube, named with the compound name path-safe (`data/booktags--bookmarks.sqlite`; `/` is legal in a filename on Linux but the store name is also used in UI and CLI output where a path-looking string misleads, so it is flattened with `--`). |
| Entities | `Bookmark`, `Tag` stay global entity names -- entities are already a global namespace today and two applications both holding "Contact" is DIRECTION.md's problem for later, not this ticket's. |
| Routes | HTTP groups own their paths as today (`/bookmarks`, `/tags`). The web route for a child screen is `/booktags/bookmarks` -- one Booktags entry in the sidebar, children as its surfaces. |

## 3. Parent/child discovery contract

Discovery reads `cubes/<name>/` and `plugins/<p>/cubes/<name>/` as today. When a mounted cube
directory contains subdirectories that are themselves cubes (an `index.ts` exporting `cube`),
those are discovered as its children. Rules:

- A child directory must declare `parent` equal to the directory it sits in -- checked at mount.
- A manifest declaring `parent` whose directory is NOT nested inside that parent fails at mount
  (`InvalidManifestError`).
- A parent may have any number of children, including zero.
- A child may not itself have children (one level -- section 2.4 of DIRECTION.md). A directory nested
  two deep is a broken cube, named at startup.
- Flat plugin cubes (`plugins/<p>/cubes/<name>/index.ts` with no subdirs) work exactly as
  today -- criterion 10.

Manifest gains one optional field, `parent?: string`. Nothing else: no central registry, no
list of children in the parent -- the parent does not name its children, the directory layout
does, and the child names its parent. Neither side can omit the other without the mount check
failing.

## 4. Lifecycle

- **Enable/disable:** the parent is one switch. Disabling `booktags` disables everything under
  it: the dispatcher, the bus and `activeLinks` already filter per cube; `isEnabled(child)`
  becomes `isEnabled(child) && isEnabled(parentOf(child))`. A child may additionally be
  switched off alone (`booktags/tags` off, bookmarks still on). A child cannot be on while its
  parent is off -- the switch file simply has no such state, because the parent's off state
  masks it.
- **Install/uninstall:** one directory, one unit. The existing installer copies a directory
  tree; Booktags arrives as one plugin subtree. Uninstalling removes the parent directory and
  therefore its children. There is no path that installs `booktags/tags` without `booktags` --
  the directory layout makes it inexpressible.
- **Update:** replace the directory, restart -- same as today.
- **Restart:** unchanged; the kernel owns process lifetime (`installer.restart`), and on boot
  the hierarchy is rediscovered from disk. Probes cover this.

## 5. Ownership of shared configuration and data

Each child owns its tables exactly as today. Booktags-level settings live in the
`booktags/settings` child, not in the parent: the parent owns no tables, matching the rule
that a cube with no tables declares no entity. The parent is a screen and a namespace root,
nothing more. Shared configuration between the children travels through the settings child's
own store; other children read it through the four legal paths (here: a relational part or a
permission-checked command), never by import.

## 6. UI navigation

One sidebar entry: **Booktags**. The catalogue gains `parent` on child entries and the shell
groups children under their parent instead of showing a flat tab each. The parent's own screen
(`/booktags`) shows its children as surfaces; each child keeps the generic list screen at
`/booktags/bookmarks`, `/booktags/tags`, and a settings screen at `/booktags/settings`.

The flat sidebar keeps working for standalone cubes -- `notes` is unchanged.

## 7. Collision rules

- Two standalone cubes, or a standalone cube and a parent, sharing a name: existing
  `DuplicateCubeError`, unchanged.
- Two children with the same compound name: impossible -- one directory layout.
- A standalone `bookmarks` and the child `booktags/bookmarks`: **both may exist**. The
  compound name is a different key in every map (switches, catalogue, commands, permissions).
  Their HTTP routes are their own business; if both claim `/bookmarks` the API composition
  fails loudly at startup (`PrefixCollisionError`), which is correct -- a route collision is
  a defect, not a namespace to arbitrate. The one sanctioned exception is the child whose
  LEAF name is taken by a mounted cube (`booktags/settings` next to core `settings`): it
  serves under `<parent>-<name>` by design -- unique by construction, still matched exactly
  by the switch -- so the collision never forms. Anything else that still collides stops
  the boot.
- Permission/command prefixes can never collide, because each is derived from the unique
  compound name.

## 8. Independent installation of children

No. A child is addressable only as `booktags/<child>` and installable only as part of the
`booktags` directory. This is deliberate: "owned runtime modules, not independent top-level
cubes accidentally grouped by a package" is the ticket's own sentence. A cube that should live
independently is a standalone cube -- the mechanism for that already exists and is unchanged.

## 9. Migration of existing bookmarks/tags

`example-plugin`'s flat `bookmarks` and `tags` cubes move into `booktags/` as children. Their
data files are renamed `data/bookmarks.sqlite` -> `data/booktags--bookmarks.sqlite` (same for
tags) by a one-time kernel migration at boot: if the old file exists and the new one does not,
rename. Both directions are checked before touching anything; a collision (both exist) stops
startup with a named error rather than a guess. The schema is unchanged (same tables, same
bodies) -- only the file name moves, so the migration is a rename, not a transform.

Ownership comes from the kernel-written `data/provenance.json` ledger. A deployment whose data
predates that ledger must authorize the first migration boot explicitly with
`QWBE_LEGACY_MIGRATIONS="bookmarks:example-plugin,tags:example-plugin"`; the variable is removed
after that successful boot. Unknown or corrupt provenance stops startup.

Compatibility: the old flat cubes are gone from the plugin, so there is nothing to be
compatible with. `notes` proves standalone cubes still work; criterion 10 is covered by the
flat-plugin path staying in discovery.

## 10. Package grouping vs runtime hierarchy

A **plugin** remains a delivery package: it decides which cubes arrive together and nothing
else. A **parent cube** is a runtime boundary: it owns a namespace, a lifecycle unit, a
sidebar area. A plugin may deliver a standalone cube, a parent with children, or several of
either -- the two concepts are orthogonal. `example-plugin` after this change delivers both
shapes at once: `booktags` (hierarchy) -- and `notes` in core shows the standalone shape. Flat
plugins containing independent cubes keep working (criterion 10).

---

## Invariants

1. One cube = one directory; installing or removing Booktags touches no existing file.
2. A manifest cannot lie: `name` matches its directory, `parent` matches its real location.
3. A child's permissions, commands and events derive from its compound name -- no second
   naming mechanism.
4. One level of nesting. A second level is a broken cube, named at startup.
5. Disabling the parent disables the subtree; the state file cannot express "child on, parent
   off".
6. The parent owns no tables. Shared configuration lives in a child (`booktags/settings`).
7. Four legal cross-cube paths, unchanged: registry, bus, space, commands. Children do not
   import each other; the tag->bookmark link moves to a space, declared by neither side.
8. Standalone cubes and flat plugins are unaffected -- verified by probes, not by inspection.

## Out of scope (unchanged from the ticket)

npm registry (QWB-10), publishing, and anything beyond the ten points above.

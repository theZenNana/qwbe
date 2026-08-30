# ADR 0001 - One Postgres, one schema per cube

Status: proposed, waiting for the owner's decision on section 2.
Date: 30 August 2026. Ticket: QWB-43. Implementation: QWB-44, which does not start before this
is accepted.

This is the first ADR written in this repository. The numbers quoted in the source
(`store.ts` cites ADR-0003, `qwbe.config.json` cites ADR-0006) belong to the earlier
software-factory series and are not continued here; the series starts again at 0001.

## 1. What we have, and why changing it costs something

Every cube gets its own SQLite file. `core/src/kernel/store.ts` opens one connection per cube,
sets WAL, and hands the cube a store bound to exactly the tables its manifest declares. Rows are
stored as JSON in a body column, paging is real SQL (`LIMIT`/`OFFSET` plus `COUNT`), and a cube
asking for a table it did not declare throws by name.

The valuable property is not the file format. It is this: **a different cube's data is not in a
table this connection can see - it is in another file, and this store never opens it.** The file
boundary makes the isolation physical rather than polite. `store.ts` is honest that this is lint
and not a sandbox - a determined cube can import the kernel store or open the file itself, and
`.dependency-cruiser.cjs` forbids both routes - but by accident it cannot happen at all.

What today's storage does NOT have, and what the CRM needs:

- no transactions: a write that touches two tables can half-land;
- no migrations: a schema change is whatever the code happens to do on next boot;
- no query across cubes, by design (compose, do not join) - which is right, and stays right;
- one file per cube means one lock per cube and no shared connection pool;
- nothing to hang an index on when custom-field values become jsonb (QWB-46).

Moving to Postgres buys transactions, migrations, jsonb with GIN, and a real pool. It **spends**
the physical isolation. The rest of this document is mostly about not spending it for nothing.

## 2. The decision that needs the owner: schema per cube

Two ways to put many cubes in one database.

**A. One schema per cube** (`notes.rows`, `crm_contacts.rows`), each cube's connection opened as a
role whose `search_path` is its own schema and which has been granted nothing on the others.
**B. One schema, prefixed tables** (`notes_rows`, `crm_contacts_rows`), told apart by name only.

Recommendation: **A, schema per cube.**

The reason is the property from section 1. With B, isolation is a naming convention: any
connection can read any table, and the only thing stopping cube `notes` from selecting the admin
password hash out of `auth_users` is that the kernel does not hand it that string. That is
strictly weaker than what we have today, so the migration would be a downgrade dressed as an
upgrade. With A, the database refuses. `GRANT USAGE ON SCHEMA notes TO cube_notes` and nothing
else means a stray query fails with a permission error, from the engine, not from our lint. It
is the closest Postgres equivalent of "it is in another file".

What A costs, stated plainly:

- one role and one schema to create per cube at install time, and to drop at uninstall - the
  installer already owns a lifecycle where this fits;
- migrations run per schema, so a kernel migration touching every cube iterates;
- connection pooling is per role, so the pool is partitioned rather than shared;
- cross-cube reporting needs a separate read role with `USAGE` on many schemas, which is a
  deliberate act rather than an accident. That is the point.

B is cheaper to build and easy to migrate to later if A proves heavy. A is expensive to migrate
to later, because by then code will assume it can see everything. Choose the reversible-in-the
-right-direction option: start with A.

**Owner: this is the one line to accept or reject.** Everything below follows either way.

## 3. What does not change

The `Store` interface the cubes see stays identical, operation for operation
(`core/src/kernel/manifest.ts`, `CubeStore`):

| operation | signature today | after |
|---|---|---|
| `all` | `(table) => Effect<ReadonlyArray<A>>` | unchanged |
| `page` | `(table, page, where?) => Effect<Page<A>>` | unchanged |
| `byId` | `(table, id) => Effect<A \| undefined>` | unchanged |
| `insert` | `(table, entityType, prefix, values) => Effect<Record>` | unchanged |
| `update` | `(table, id, patch) => Effect<Record \| undefined>` | unchanged |
| `count` | `(table) => Effect<number>` | unchanged |

No cube changes for this migration. If a cube has to change, the port is wrong.

Also unchanged: cubes never join across cubes; the manifest still declares the tables a cube may
touch; `checkUniqueTables` still refuses two cubes claiming one table.

## 4. Storage shape

- The row body stays `jsonb`, with a GIN index per table. That is what makes custom-field values
  (QWB-46) queryable without a column per field, and it is why jsonb rather than json: jsonb is
  the one with the index.
- The meta columns (`id`, `type`, `createdAt`, `deleted`) become real columns, not keys inside
  the body, because they are what paging, sorting and the drift gate already sort on.
- Every write runs in a real transaction. `insert` and `update` each become one transaction; the
  kernel keeps the handle so a future multi-table operation can wrap several.
- Migrations are files, applied in order, recorded in a kernel-owned table. A boot that finds an
  unapplied migration applies it or refuses to start - it does not guess.

## 5. The outbox

One kernel-owned table, written **in the same transaction as the row it describes**. Nothing
consumes it in phase 1.

| column | meaning |
|---|---|
| `id` | monotonic, the consumer's cursor |
| `cube` | which cube wrote |
| `table` | which table |
| `rowId` | the row |
| `op` | insert, update, delete |
| `version` | the row's version after the write |
| `at` | timestamp |

Writing it costs one insert per write and buys the guarantee that matters: there is no state in
which the row changed and the event did not. A relay to Elasticsearch, or to anything else, is a
later ticket and is explicitly out of phase 1. We are not building a queue now; we are making
sure that when we do, the history is already there and complete.

## 6. Single tenant

One customer (Global Tech). No `tenantId`, no row-level security in phase 1.

Recorded as a future option with its price: adding RLS later means a `tenantId` column on every
table, a policy per table, and a connection that sets the tenant per request. Doing it now would
cost that complexity in every query for a second customer that does not exist. Doing it later is
a migration, not a redesign - acceptable.

## 7. Migrating the existing data

Per cube, `data/<cube>.sqlite` to the cube's new schema, with a check that can actually be run:

1. count rows per table in SQLite;
2. copy, preserving `id`, `createdAt` and the body verbatim;
3. count rows per table in Postgres;
4. compare, per table: same count, and the same set of `id` values (compare sorted checksums,
   not eyeballs);
5. sample the body of a fixed number of rows and compare byte for byte;
6. a row that fails to convert stops the migration for that cube and is reported by id - it is
   never skipped silently.

The old file is not deleted. It is renamed with a suffix, so a failed migration rolls back by
pointing the kernel at SQLite again.

## 8. Not in phase 1

Elasticsearch and any relay from the outbox; multi-tenant and RLS; sharding; read replicas;
cross-cube joins; changing the `Store` interface.

## 9. Consequences

- One database to run, back up and restore, instead of a directory of files.
- Isolation stops being a property of the filesystem and becomes a property of Postgres grants.
  If the grants are wrong, the isolation is gone and nothing in the code will say so - so the
  grants need a probe of their own: a cube's connection trying to read another schema must fail,
  and that test must live in the gates.
- A cube that today cannot see another cube's file will, after this, be one `GRANT` away from
  seeing everything. That is the risk this ADR accepts, and section 2 is how it is contained.

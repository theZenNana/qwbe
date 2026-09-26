# Qwbe - prototype

Qwbe is a prototype for discovering, installing and composing isolated application modules
without editing a central registry. Current code demonstrates the invariant and its limits; it is
not a production-ready service.

Licensed under the [MIT License](./LICENSE). The three package manifests stay
`private: true` because this repository is not published as three npm packages;
that flag does not make the source license private.

Implemented now: seven core cubes, one example plugin (a runtime hierarchy), one relation
space, package lifecycle, entity ownership and sharing, metadata-driven screens, CLI commands, paging
and declared data migrations. Not implemented: application namespaces beyond one
hierarchy level, external rules, workflows, schema migrations, multi-tenancy or process
isolation. Those belong to the roadmap in `wiki/qwbe/DIRECTION.md`, not to current capability.

## Running it

Two steps, both from the project root. Node 22.18 or newer - the API and tests execute TypeScript
directly through Node type stripping.

```bash
npm run db:up       # starts the Postgres container (docker compose)
npm run setup       # npm ci at root/core/web, creates data/, checks the Node version
npm start           # API on :4500 and the web app on :4510, in one terminal
```

Storage is one Postgres database with one schema per cube (ADR-0001). The server names it with
`QWBE_DATABASE_URL` (see `.env.example`); missing or unreachable, it refuses to start. No SQLite
per cube any more.

`npm start` prefixes every log line with `[api]` or `[web]`, and Ctrl-C stops both. The tools
behind the scripts live in `core/tools/`: `bootstrap.ts` and `setup.ts` (setup), `dev.ts`
(start, api, web), `db.ts` (db:up, db:down), `e2e.ts`, `check.ts`.

Root tooling, `core/`, and `web/` are independent npm packages with one committed lockfile each.

Open <http://127.0.0.1:4510> and sign in with credentials created for the installation.
Swagger at <http://127.0.0.1:4500/docs>, the raw spec at `/openapi.json`.

Moving the ports: `QWBE_PORT=4530 npm start` moves the API and tells the frontend where it
went. `QWBE_WEB_PORT=4540 npm start` overrides the web port. Without them, both ports come from
the `dev:` block of `qwbe.yaml`. The start runner respawns a cleanly exited API, so the
admin restart action returns under this documented flow without stopping the frontend.
`QWBE_DATABASE_URL` moves the database.

### First account and password storage

On an empty database, Qwbe creates only the `admin` account. Set `QWBE_ADMIN_PASSWORD` before
first start to supply its bootstrap password. Without it, Qwbe generates 24 random bytes and
prints the base64url password once to stderr; later starts do not print or replace it.

Passwords use Node's scrypt with a random 16-byte salt per account: N=16384, r=8, p=1 and a
32-byte derived key. Stored hashes include algorithm, parameters and salt. Existing prototype
SHA-256 hashes remain login-compatible only for migration and are replaced with scrypt after
their first successful login. `QWBE_READER_PASSWORD` creates the demonstration reader only when
explicitly set; checks and browser tests set both variables inside their isolated processes.

Running the halves separately, in two terminals:

```bash
npm run api                            # API on :4500, respawned after an admin restart
npm run web                            # sibling app on :4510
```

`cd core && node src/main.ts` still starts the API with no supervisor: the admin restart action
stops it.

The frontend reads the API address from `NEXT_PUBLIC_QWBE_API` (default `http://127.0.0.1:4500`).
Demo records use `example.com`, the IANA-reserved documentation domain; they are fixtures, not
real contacts or service dependencies.

### Access from another machine (LAN)

Out of the box everything assumes `127.0.0.1`. To run Qwbe on one machine and open it from
another, three things must change — miss any one of them and the symptom is confusingly silent:

```bash
NEXT_PUBLIC_QWBE_API=http://<host-ip>:4500 QWBE_DEV_ORIGINS=<host-ip> npm start
```

- `NEXT_PUBLIC_QWBE_API` — the browser, not the server, calls the API; leave it default and the
  visitor's browser calls *its own* 127.0.0.1.
- `QWBE_DEV_ORIGINS` — Next dev refuses to serve its chunks to a page opened under an unknown
  host. The page then sticks at the initial `…` and never hydrates, with **no console error and
  no API request** — the only trace is `Blocked cross-origin request` in the dev server's own
  log. Comma-separate multiple hosts.
- The host firewall must allow TCP 4500 and 4510 (e.g. firewalld: add both ports, then
  `--reload` — the `--permanent` flag alone does not touch the running rules).

Locked out because the printed bootstrap password is gone (say, the first start ran in a
terminal nobody kept)? Stop Qwbe, set `QWBE_ADMIN_PASSWORD`, drop the server's database and let
the next start recreate it -- this **erases all data**, acceptable only on a fresh install.

The Playwright suite (`npm run e2e`: web build, then `qwbe.spec.mjs`) uses the root
dependencies installed by setup. Browser binaries remain a separate Playwright install.

## Verifying it

```bash
npm run check          # every gate, in order; needs the database from db:up
npm run check:strict   # same, but ignores the `untested:` list in qwbe.yaml
npm run check:bench    # adds the benchmarks; budgets in the `bench:` block of qwbe.yaml
npm run e2e            # the UI, terminal included
```

`check` (`core/tools/check.ts`, gates in `core/tools/gates.ts`) runs typecheck, typecheck:web,
lint, test, boundaries, testgate, untracked, secrets and audit, and exits 1 if any is red. The
`test` gate runs vitest over `core/checks/`: `unit/`, `integration/` and `live/`; `bench/` runs
only under `check:bench`. Most of these checks are ports of the old `probes/*.mjs`, and each
file names the probes it came from.

The attacks in `core/checks/integration/api-auth-matrix.test.ts` exist because two independent
adversarial reviews found real holes here. Each is an attack that once succeeded, or one written
to make sure a fixed hole stays shut.

The checks start whatever servers they need and stop them afterwards. That is deliberate: a
server started by an agent lives inside that agent's sandbox - `ss` reports LISTEN while a
request from anywhere else gets ECONNREFUSED. Producing the evidence in the same place as the
act is the only way it means anything.

CI (`.github/workflows/verify.yml`) starts from a clean checkout with a Postgres service, runs
`setup`, installs gitleaks, runs `check`, then `e2e`. The workflow is currently disabled on
GitHub, pending an owner decision, so nothing runs on push today.

## Committing to this repo

No git hooks run at commit time. What used to be hooks is either a gate of `check` or a
convention:

**No credentials.** `.env` and everything matching `.env.*` are ignored; commit `.env.example`
with placeholders instead. The `secrets` gate of `check` runs secretlint over every tracked file
(rules and allowlist in `.secretlintrc.json`), then gitleaks over the commits in
`origin/main..HEAD`. Run `npm run check` before a push.

**Work on a branch named `<type>/<slug>`**, never on `main`. Types: `feature`, `fix`,
`hardening`, `refactor`, `docs`, `test`, `experiment`, `chore`. Nothing enforces this any more.

**Commit messages**: ASCII, subject at most 72 characters, no trailing period, blank line before
the body. Deliberately not Conventional Commits - the messages here carry a sentence of reasoning,
and a machine-readable prefix adds nothing to that.

## The invariant

> **One cube = one directory. Installing it touches no existing file.**

Not a claim, a measurement. `core/checks/integration/discovery-no-registry.test.ts` fingerprints
every file under `core/`, places a plugin, starts the server, calls its route - and only then
compares. No file under `core/` may change.

The probe it replaced also created a core cube (result on 1 Aug: **22 files untouched, 2
added**) and removed the `notes` cube from disk entirely. The server started, `account`
carried on, the notes permissions dropped out of `auth` by themselves, its commands left the
CLI, and its group vanished from the account page. Nothing edited anywhere.

## Two levels

```
LEVEL 0   cubes/<name>/                          flat namespace - core cubes
          plugins/<p>/cubes/<name>/              ...and plugin cubes, in the SAME namespace
          cubes/<parent>/<child>/                one level of runtime hierarchy (parent + owned children)

LEVEL 1   spaces/<name>/                         no cubes. Only the connections between them.
```

A child cube lives inside its parent's directory and is addressed `<parent>/<child>`: same
namespace, one level deeper. The parent is the lifecycle unit -- switching it off takes the
children with it; a child can still be off alone. Discovery is exactly one level deep, and a
child whose leaf name collides with a mounted cube serves under `<parent>-<name>`. The
canonical example is `booktags` in the example plugin (docs/booktags-hierarchy.md).

Shipping a whole PACKAGE - a directory with a `qwbe-package.json` and its own cubes - has
its own contract, in one page: docs/package-contract.md.

A space keeps relation knowledge outside both cubes. Without it, `notes` would need the string
`"Account"` inside its own directory - not an import, but still knowledge of another cube.

Now the link lives in `spaces/workspace/index.ts`, declared by neither side:

```ts
link({ from: "notes", field: "authorId", to: "Account", label: "notes" })
```

Checked mechanically, with comments stripped so only code counts:

```
grep -r Account cubes/notes/     → nothing
grep -r notes   cubes/account/   → nothing
```

## The legal paths between cubes - and the only ones

| Path | For | Travels by |
|---|---|---|
| **registry** | another cube's data, as a summary it chose | string |
| **bus** | "something happened" | string |
| **space** | the link between two cubes | string, declared by a third party |
| **commands** | one cube's command, run from the CLI | string, dispatched by the kernel |
| **capability** | a narrow typed service declared in manifests | public `qwbe-core/*` contract, injected by the kernel |

Permissions uses the capability path. Auth still owns identity and sessions; Account exposes only
stable `id` and `username`; the Permissions cube owns cube admins, entity ownership, grants,
personal Hide/Unhide and the audit trace. A consuming cube declares `usesEntityPermissions` and
receives the public `qwbe-core/permissions` service. It never imports the Permissions cube.

A direct import is stopped by `dependency-cruiser`, exit 1. Verified by deliberate violation,
not by reading the config: cube→cube, kernel→cube, a cube importing the store factory, and a
cube importing `node:sqlite`, `node:fs`, `node:child_process`, `node:module` or `node:vm`.

**The honest limit.** This is lint, not a sandbox. A literal `await import("node:fs")` is caught;
`await import("node:" + "fs")` is not, and no static tool can catch it. Inside one process under
one uid there is no barrier - a real one means a separate process per cube. Two reviewers made
this point independently after demonstrating the bypass, and the claim in `store.ts` was corrected
from "impossible" to what is actually true.

## Data migrations

When a cube's identity moves (flat `bookmarks` -> `booktags/bookmarks`), its store file must
follow. The migration is DECLARED in the parent package's manifest, never executed by the cube:

```ts
dataMigration: [
  {
    fromCube: "bookmarks",
    toCube: "booktags/bookmarks",
    fromPlugin: "example-plugin",
  },
]
```

The kernel runs it at mount, before any store opens, under strict rules: `toCube` must be a
mounted cube of the same package, every schema rename is preflighted before the first one runs
(one Postgres transaction per rename, rows move as metadata), and a failed move rolls the whole
batch back. A manifest cannot
name a path, and a plugin cannot reach outside its own package.

The kernel records ownership in `data/provenance.json`. Existing installations created before
that ledger need one explicit operator authorization for the Booktags rename:

```bash
QWBE_LEGACY_MIGRATIONS="bookmarks:example-plugin,tags:example-plugin" npm start
```

Use it only for the first successful migration boot, then remove it. Missing, malformed or
unrecorded provenance stops startup; the kernel never guesses ownership.

## The cubes

| Cube | Kind | What it does |
|---|---|---|
| `auth` | system, required | sessions only. Opaque token: 32 random bytes, only `sha256` stored |
| `account` | system, required | user accounts and roles. Holds the `Account` entity |
| `settings` | system, required | switch cubes on and off. The only cube with a declared privilege |
| `cli` | system | aggregates the commands cubes declare, and runs them via `POST /cli/exec` |
| `links` | system | serves the relation queries. Owns no data at all |
| `notes` | example | notes with an author. The second entity, without which no link could be shown |
| `booktags` | **plugin** | parent cube in `plugins/example-plugin/` -- a namespace root and one sidebar entry |
| `booktags/bookmarks` | **plugin** | child: bookmarks pointing at a real mounted cube |
| `booktags/tags` | **plugin** | child: labels a bookmark. The link to `Bookmark` lives in the workspace space, declared by neither cube |
| `booktags/settings` | **plugin** | child: the hierarchy's own setting, shared with the bookmarks sibling over the bus |

## The generic agent surface

A cube can expose an agent or any other external runtime by declaring one capability in its
manifest:

```ts
manifest: { name: "mycube", agent: true, /* ... */ }
```

That single declaration is the whole contract between kernel, catalogue, API and UI:

- the cube must serve four routes under its own prefix -- `GET /<cube>/health`,
  `GET /<cube>/context`, `POST /<cube>/goals`, `GET /<cube>/trace` -- against the shared
  schemas in `core/src/agent-contracts.ts` (`qwbe-core/agent`). The mount gate checks the REAL
  endpoint list: declaring `agent: true` without the full surface refuses the cube at startup.
  A button with nothing behind it cannot exist.
- the catalogue publishes `agent: true` and the shell draws an "agent" link plus the generic
  `/agent/<cube>` screen from that alone -- no per-cube code in the web app, no parallel
  contracts written by hand.
- the screen reports the three states the contract defines: `ready` (health answered),
  `unavailable` (the surface answered 503 -- not configured or not started) and `error`
  (the surface did not answer its own contract).

The kernel never learns what sits behind the surface: interpreter, model, wire format and
versions stay inside the plugin's directory. Qwbe provides only this generic capability; no
runtime implementation or built-in agent plugin lives in this repository.

## Design lineage

| From | What | Where it shows |
|---|---|---|
| **Module isolation** | a module cannot reach another's data | `kernel/store.ts`: one Postgres schema per cube, `ForeignTableError` |
| **External relations** | links declared outside both modules | `kernel/space.ts` and `spaces/workspace/` |
| **Declared privilege** | an escape hatch declared at install time | `manifest.managesCubes`, at most one, checked at mount |
| **Runtime verification** | verify the real artefact, never a self-set flag | `kernel/mount.ts` reads `group.endpoints[].middlewares` |
| **Metadata UI** | screens generated from API metadata | `web/app/[cube]/`, two files for every cube |

## What two adversarial reviews found - and what came of it

Both reviews ran the server rather than reading the code, and each finding below was reproduced
before it was fixed. The two most serious were security holes, not style:

- **Any `reader` could read the administrator's password hash.** `account` put `passwordHash`
  into its public registry summary so that `auth` could check a password; `links` served that
  summary to anyone holding `links:read`. One channel doing two incompatible jobs - showing a row
  to anyone, and proving a password. Fixed by splitting them: `providesCredentials` /
  `usesCredentials`, wired by the kernel, hash never leaves its cube.
- **Login died permanently after the third restart.** Ids came from a module-level counter that
  reset to zero each boot and was shared across every cube, so it eventually reissued an id that
  already existed: `UNIQUE constraint failed: sessions.id`, and nothing self-healed. Ids are
  random now.
- **"Switched off" did not switch off**, two independent ways: a cube declaring a route under
  another's prefix stayed reachable, and a cube named with a `:` sent its commands to another
  cube's switch. Both are refused at mount now.
- **Ordering by a hidden column** (`?sortBy=passwordHash`) was an oracle even after the leak was
  closed, because sorting reads the stored row rather than the response. Cubes now publish which
  fields are sortable.
- **Any cube could run any command.** `commands()` handed every cube the actual `run` function,
  so a cube declaring no permissions at all called `account:list` with no token and no session -
  and `dependency-cruiser` reported zero violations, because nothing forbidden had been imported.
  It used exactly what the kernel gave it. Worse than the store hole for that reason: a boundary
  rule cannot catch a legal call. Of the four paths between cubes, `commands` was the only one
  passing executable capability rather than mediated data. The dispatcher now lives in the kernel,
  checks the caller's permissions inside itself, and is given only to the cube declaring
  `runsCommands: true`; everyone else sees `{ name, summary, permission, maxArgs }`.
- Plus: `?offset=NaN` and `?offset=1e400` reaching the database as an empty 500, a throwing bus
  listener stopping delivery to everyone after it, duplicate commands silently ignored,
  `cli:help` handing out commands the caller cannot run, and a disabled cube being
  distinguishable from a missing one without a token.

Three of my own fixes needed a second pass, each caught by attacking rather than reading: the
builtin-import rule matched `node:sqlite` but not `node:fs`; the disabled-cube 404 was still
distinguishable after the first attempt; and `finiteInt` let `1e20` through because it is finite.

## What the probes caught while building

History from before `core/checks/` replaced the repo's `probes/`. Worth keeping, because each
was a real mistake and a probe is why it did not survive:

- **A dangling link used to stop the server.** The invariant probe caught it immediately:
  deleting `notes` broke startup, because the space still pointed at it - which would mean
  uninstalling a cube requires editing a file that is not yours. And a typo cannot be told apart
  from a deliberate removal. It is now a loud warning at startup, and the link is inactive.
- **The auth middleware asked for the registry at request time**, where it does not exist. Login
  worked (an ordinary handler has the registry) while every authenticated route returned 500.
  The service is now resolved once, while the layer is built.
- **The Bearer token arrives as `Redacted`**, not a string - Effect hides it so it cannot reach
  a log by accident.

## Deliberately unresolved

- **`any` where the contract is composed** (`kernel/mount.ts`). The type of a composed `HttpApi`
  *is* its list of groups, so runtime composition loses it. Checked against the Effect docs:
  `add()` and `addHttpApi()` exist, but there is no documented pattern for optionally-mounted
  groups with types preserved, and no large open-source Effect application to copy from. Confined
  to two functions; the emitted OpenAPI stays complete.
- **Passwords are SHA-256 with a fixed salt**, not argon2 - a native dependency is not worth it
  in something disposable. Not production, and it says so in the code.
- **Public/private key login** was left out on purpose: password login was asked for first. That
  change touches this one cube; the rest of the system only ever sees `CurrentUser`.

## Layout

```
core/
  src/kernel/      manifest · discovery · store · registry · bus · space · pagination · mount · state
  src/cubes/       LEVEL 0 - one directory per cube
  src/spaces/      LEVEL 1 - connections only, no cubes
  src/main.ts      knows no cube by name
  plugins/         installed plugins, each bringing cubes into level 0
  .dependency-cruiser.cjs
  checks/          unit, integration, live, bench; run by vitest under `npm run check`
  tools/           setup, dev, db, e2e, build, check and its gates
web/               Next.js. `lib/session.ts` holds the session half of authentication
qwbe.yaml          dev ports, the untested work queue, benchmark budgets
qwbe.spec.mjs      Playwright, run by `npm run e2e`
data/              files the admin restart and checks use; the store lives in Postgres
```

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
npm run db:down     # stops the container; `npm run db:clean` drops test databases left by killed runs
```

Storage is one Postgres database with one schema per cube (ADR-0001). The server names it with
`QWBE_DATABASE_URL` (see `.env.example`); missing or unreachable, it refuses to start. No SQLite
per cube any more.

`npm start` prefixes every log line with `[api]` or `[web]`, and Ctrl-C stops both. Every npm
command runs a small Effect program in `core/tools/` (`setup/setup.ts`, `dev/dev.ts`, `db/db.ts`, `check/check.ts`,
`dev/e2e.ts`, `dev/build.ts`). `npm run setup` starts through `core/tools/setup/bootstrap.mjs`, which installs
`core/` first on a fresh clone, because the tools need `effect` from it.

Root tooling, `core/`, and `web/` are independent npm packages with one committed lockfile each.

Open <http://127.0.0.1:4510> and sign in with credentials created for the installation.
Swagger at <http://127.0.0.1:4500/docs>, the raw spec at `/openapi.json`.

Moving the ports: the defaults are `dev.api` and `dev.web` in `qwbe.yaml`. `QWBE_PORT=4530 npm start`
moves the API for one run and tells the frontend where it went; `QWBE_WEB_PORT=4540 npm start`
moves the web port. `npm start` refuses to start when a port is already taken. The start runner respawns a cleanly exited API, so the
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

Running the halves by hand still works, if you want two terminals:

```bash
cd core && node src/main.ts            # API on :4500  (QWBE_PORT to move it)
cd web  && npm run dev                 # sibling app on :4510
```

This manual API process has no supervisor: the admin restart action stops it. Use `npm start`
when restart from the admin screen must bring the API back while keeping the frontend alive.

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

The Playwright suite (`npm run e2e`) uses the root dependencies installed by setup. Browser
binaries remain a separate install: `npx playwright install chromium`.

## Verifying it

One command runs every gate and reports each one; it does not stop at the first red:

```bash
npm run check         # typecheck, typecheck:web, lint, test, boundaries, testgate, untracked, secrets, audit
npm run check:strict  # the same, without the testgate exemptions listed under `untested` in qwbe.yaml
npm run check:live    # plus the live checks: real servers booted on free ports
npm run check:bench   # plus the benchmarks, held against the budgets under `bench` in qwbe.yaml
npm run e2e           # builds the web app, then runs the Playwright suite (qwbe.spec.mjs)
```

The verdict is the exit code: 0 when every gate is green. `test`, `live` and `bench` need
Postgres (`npm run db:up`); each test file creates its own `qwbe_test_*` database and drops it
when it ends. `QWBE_PG_HOST`, `QWBE_PG_PORT`, `QWBE_PG_USER` and `QWBE_PG_PASSWORD` point the
checks at another server (default `localhost:5433`, `postgres`, `qwbe`).

Where the checks live:

```
core/tools/               the npm commands and the gates (check/check.ts, check/gates.ts, check/testgate.ts, check/untracked.ts)
core/checks/unit/         no server, no database
core/checks/integration/  one Postgres database per file, no HTTP server
core/checks/live/         real servers and processes (`check:live`)
core/checks/bench/        vitest bench against the qwbe.yaml budgets (`check:bench`)
core/checks/_layers/      shared Effect layers: test database, booted server, API client
core/checks/_fixtures/    fixture packs
core/src/**/*.test.ts     kernel and cube tests, on vitest (packs in core/plugins stay on node:test)
```

The live checks start whatever servers they need and stop them afterwards. That is deliberate: a
server started by an agent lives inside that agent's sandbox - `ss` reports LISTEN while a
request from anywhere else gets ECONNREFUSED. Producing the evidence in the same place as the
act is the only way it means anything.

CI (`.github/workflows/verify.yml`) runs `npm run setup`, `npm run check` with a Postgres service
and gitleaks, then `npm run e2e`. The workflow is disabled on GitHub until the owner turns it
back on; until then, green means green locally.

## Committing to this repo

There are no commit hooks. Run `npm run check` before a commit; its `secrets` gate does what the
old pre-commit hook did.

**Work on a branch named `<type>/<slug>`.** Types: `feature`, `fix`, `hardening`, `refactor`,
`docs`, `test`, `experiment`, `chore`. Slug is lowercase ASCII words joined by single hyphens.
Never commit on `main`; it receives merges from pull requests.

**No credentials.** `.env` and everything matching `.env.*` are ignored; commit `.env.example`
with placeholders instead. `git add -f` walks past `.gitignore`, so the `secrets` gate scans
anyway: secretlint over every tracked file (GitHub, Slack and AWS tokens, `sk-` keys, private-key
blocks, basic-auth URLs, hardcoded `password =` assignments, `/home/<user>/` paths; rules and the
allowlist in `.secretlintrc.json`), and gitleaks over the commits in `origin/main..HEAD`.

**Commit messages**: ASCII, subject at most 72 characters, no trailing period, blank line before
the body. Deliberately not Conventional Commits - the messages here carry a sentence of reasoning,
and a machine-readable prefix adds nothing to that.

## The invariant

> **One cube = one directory. Installing it touches no existing file.**

Not a claim, a measurement. `core/checks/integration/discovery-no-registry.test.ts` places a
plugin in a temporary plugins directory and checks that it reaches the catalog, OpenAPI,
permissions and CLI while no tracked file under `core/` changes.
`core/checks/live/boot-smoke.test.ts` boots without the `notes` cube: its routes and permissions
are simply absent. `npm run boundaries` refuses any import from one cube into another.

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

Worth keeping, because each was a real mistake and the probe is why it did not survive:

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
  tools/           the npm commands and gates, in Effect (see "Verifying it")
  checks/          unit, integration, live and bench checks, on vitest + @effect/vitest
  qwbe.config.json size caps `qwbe check` measures a pack against
web/               Next.js. `lib/session.ts` holds the session half of authentication
qwbe.yaml          dev ports, the testgate exemptions, bench budgets (read by core/tools/shared/config.ts)
qwbe.spec.mjs      Playwright (5)
data/              files the admin restart uses; the store lives in Postgres
```

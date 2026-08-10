# Qwbe - prototype

Qwbe is a prototype for discovering, installing and composing isolated application modules
without editing a central registry. Current code demonstrates the invariant and its limits; it is
not a production-ready service.

Licensed under the [MIT License](./LICENSE). The three package manifests stay
`private: true` because this repository is not published as three npm packages;
that flag does not make the source license private.

Implemented now: six core cubes, one example plugin, one relation space, package lifecycle,
runtime permissions, metadata-driven screens, CLI commands and paging. Not implemented:
application namespaces, external rules, workflows, schema migrations, multi-tenancy or process
isolation. Those belong to the roadmap in `wiki/qwbe/DIRECTION.md`, not to current capability.

## Running it

Two steps, both from the project root. Node 22.18 or newer - the API and tests execute TypeScript
directly through Node type stripping.

```bash
npm run setup        # npm ci at root/core/web, creates data/, checks the Node version
npm start            # API on :4500 and the web app on :4510, in one terminal
```

`npm start` prefixes every log line with `[api]` or `[web]`, and Ctrl-C stops both. Neither
script adds a dependency: they are plain Node, `scripts/setup.mjs` and `scripts/start.mjs`.

Root tooling, `core/`, and `web/` are independent npm packages with one committed lockfile each.
`npm run compliance` regenerates `sbom.spdx.json` and `THIRD_PARTY_NOTICES.md` from those exact
lockfiles.

Open <http://127.0.0.1:4510> and sign in with credentials created for the installation.
Swagger at <http://127.0.0.1:4500/docs>, the raw spec at `/openapi.json`.

Moving the ports: `QWBE_PORT=4530 npm start` moves the API and tells the frontend where it
went. `QWBE_WEB_PORT=4540 npm start` overrides the web port; otherwise the `-p` argument in
`web/package.json` remains its source. The start runner respawns a cleanly exited API, so the
admin restart action returns under this documented flow without stopping the frontend.
`QWBE_DATA_DIR` moves the databases.

### First account and password storage

On an empty database, Qwbe creates only the `admin` account. Set `QWBE_ADMIN_PASSWORD` before
first start to supply its bootstrap password. Without it, Qwbe generates 24 random bytes and
prints the base64url password once to stderr; later starts do not print or replace it.

Passwords use Node's scrypt with a random 16-byte salt per account: N=16384, r=8, p=1 and a
32-byte derived key. Stored hashes include algorithm, parameters and salt. Existing prototype
SHA-256 hashes remain login-compatible only for migration and are replaced with scrypt after
their first successful login. `QWBE_READER_PASSWORD` creates the demonstration reader only when
explicitly set; probes and browser tests set both variables inside their isolated processes.

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

The Playwright suite (`npm run e2e`, `npm run screenshots`) uses the root dependencies installed
by setup. Browser binaries remain a separate Playwright install.

## Verifying it

```bash
node probes/smoke.mjs                                          # 27 - behaviour, login to logout
node probes/decoupling.mjs                                     # 22 - the invariant, by SHA-256 fingerprint
node probes/security.mjs                                       # 35 - attacks on this README's own claims
node probes/restart.mjs                                        #  3 - survives restarts against one database
node probes/drift.mjs                                         # 11 - five disk/process drift states
node probes/admin-restart.mjs                                 #  5 - admin restart returns under npm start
cd core && npx depcruise src plugins --config .dependency-cruiser.cjs   # boundaries on the real graph
npx playwright test                                            #  5 - the UI, terminal included
node screenshots.mjs                                           # writes screenshots/
```

`probes/security.mjs` exists because two independent adversarial reviews found real holes here.
Every check in it is an attack that once succeeded, or one written to make sure a fixed hole
stays shut.

The probes start whatever servers they need and stop them afterwards. That is deliberate: a
server started by an agent lives inside that agent's sandbox - `ss` reports LISTEN while a
request from anywhere else gets ECONNREFUSED. Producing the evidence in the same place as the
act is the only way it means anything.

CI starts from a clean checkout, audits all three package trees, checks generated compliance
files, runs `check`, `probe:all`, the production web build, and Playwright. Existing testgate and
sizecaps debt remains recorded in committed baselines; owner accepted that debt for this ticket
on 2026-08-09. New regressions still fail the ordinary `check` gate.

## Committing to this repo

Four checks run at commit time, installed by `npm install` (husky sets `core.hooksPath`). Each one
exists because the thing it catches already happened here.

**Work on a branch.** `.husky/pre-commit` refuses `master` and `main`. Two agents committing
straight to master is how this repo ended up with changes nobody expected to find in the working
tree. For a deliberate one-off, `QWBE_ALLOW_MASTER=1 git commit ...` - it prints a warning, so the
exception is visible in the terminal rather than silent.

**Name the branch `<type>/<slug>`.** Types: `feature`, `fix`, `hardening`, `refactor`, `docs`,
`test`, `experiment`, `chore`. Slug is lowercase ASCII words joined by single hyphens, 40
characters at most. The vocabulary and the reasoning live in `scripts/check-branch.mjs`; run
`npm run branch` to check a name before using it. The repo previously carried 24 branches in four
different naming habits at once, which made the branch list unreadable.

**No credentials.** `.env` and everything matching `.env.*` are ignored and refused by name even
when forced in with `git add -f`; commit `.env.example` with placeholders instead. On top of that,
secretlint scans every staged file: GitHub, Slack and AWS tokens, `sk-` keys, private-key blocks,
basic-auth URLs, hardcoded `password =` assignments, and `/home/<user>/` paths. Rules and the
allowlist are in `.secretlintrc.json`; run `npm run secrets` to scan the whole tree.

**ASCII in source.** Checked on the lines a commit ADDS, not on whole files - 114 of 130 tracked
files still contain Romanian prose, and whole-file checking would block every commit until that
translation is finished. `npm run ascii` runs the whole-file version. Exemptions, each with its
reason, are in `scripts/check-ascii.mjs`.

**Commit messages**: ASCII, subject at most 72 characters, no trailing period, blank line before
the body. Deliberately not Conventional Commits - the messages here carry a sentence of reasoning,
and a machine-readable prefix adds nothing to that.

### What this does not do

A git hook is a nudge, not a boundary:

- `git commit --no-verify` skips all of it.
- A fresh clone has no hooks at all until someone runs `npm install`.
- Hooks are files in the working tree, so a branch that does not contain `.husky/pre-commit` is
  not protected by it. This was measured, not assumed: committing to master was still possible
  until this commit was merged into master.

There is no CI and no remote behind these checks. A green hook means the obvious mistakes were
caught, not that the commit is safe to publish.

## The invariant

> **One cube = one directory. Installing it touches no existing file.**

Not a claim, a measurement. `probes/decoupling.mjs` fingerprints every file under `core/`,
creates a cube AND installs a plugin, starts the server, calls both their routes - and only then
compares. Result on 1 Aug: **22 files untouched, 2 added**.

It also removes the `notes` cube from disk entirely. The server starts, `account` carries on,
the notes permissions drop out of `auth` by themselves, its commands leave the CLI, and its
group vanishes from the account page. Nothing edited anywhere.

## Two levels

```
LEVEL 0   cubes/<name>/              flat namespace - core cubes
          plugins/<p>/cubes/<name>/  ...and plugin cubes, in the SAME namespace

LEVEL 1   spaces/<name>/             no cubes. Only the connections between them.
```

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

## The four legal paths between cubes - and the only ones

| Path | For | Travels by |
|---|---|---|
| **registry** | another cube's data, as a summary it chose | string |
| **bus** | "something happened" | string |
| **space** | the link between two cubes | string, declared by a third party |
| **commands** | one cube's command, run from the CLI | string, dispatched by the kernel |

A direct import is stopped by `dependency-cruiser`, exit 1. Verified by deliberate violation,
not by reading the config: cube→cube, kernel→cube, a cube importing the store factory, and a
cube importing `node:sqlite`, `node:fs`, `node:child_process`, `node:module` or `node:vm`.

**The honest limit.** This is lint, not a sandbox. A literal `await import("node:fs")` is caught;
`await import("node:" + "fs")` is not, and no static tool can catch it. Inside one process under
one uid there is no barrier - a real one means a separate process per cube. Two reviewers made
this point independently after demonstrating the bypass, and the claim in `store.ts` was corrected
from "impossible" to what is actually true.

## The cubes

| Cube | Kind | What it does |
|---|---|---|
| `auth` | system, required | sessions only. Opaque token: 32 random bytes, only `sha256` stored |
| `account` | system, required | user accounts and roles. Holds the `Account` entity |
| `settings` | system, required | switch cubes on and off. The only cube with a declared privilege |
| `cli` | system | aggregates the commands cubes declare, and runs them via `POST /cli/exec` |
| `links` | system | serves the relation queries. Owns no data at all |
| `notes` | example | notes with an author. The second entity, without which no link could be shown |
| `bookmarks` | **plugin** | in `plugins/example-plugin/`. Proof the plugin path works, not a description of it |
| `tags` | **plugin** | second cube of the same plugin: labels a bookmark. The link to `Bookmark` lives in the workspace space, declared by neither cube |

## Design lineage

| From | What | Where it shows |
|---|---|---|
| **Module isolation** | a module cannot reach another's data | `kernel/store.ts`: one SQLite file per cube, `ForeignTableError` |
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
  random now, and `probes/restart.mjs` exists so it cannot come back quietly.
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
web/               Next.js. `lib/session.ts` holds the session half of authentication
probes/            smoke.mjs (27) · decoupling.mjs (22) · lib.mjs
qwbe.spec.mjs      Playwright (5)
screenshots.mjs    screenshots
data/              one .sqlite per cube
```

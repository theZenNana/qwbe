# Stage 1 map: probes and scripts to Effect checks

Date: 2026-09-26. State read: `main` at `a738d95`, clean tree. Document only: this stage changes
no source, runs no gate in CI and writes nothing to git. Paths are relative to the repo root.

## Rule: nothing old is deleted before stage 2 is confirmed

No old probe, script or hook is deleted before stage 2 is confirmed: old and new checks green on
the same commit. Until CI is re-enabled (owner decision 12), "green" means green locally.
Deletion of old files happens only in stage 5.

## Stages

Each stage stops; the owner decides whether to continue.

| # | stage | scope | stop condition |
|---|---|---|---|
| 1 | Map | Every probe and script gets a destination (new check or DROP with a reason). Document only. | This map closed and merged. |
| 2 | Base | vitest + `@effect/vitest`; `core/tools/check.ts` with today's gates plus `secrets`; destructive probes leave `probe:all`. | Old and new `check` green on the same commit (locally until CI is re-enabled). |
| 3 | Unit + integration | `_layers`, unit and integration checks, one domain at a time. Old `probe:all` stays. | Per domain: the new checks for that domain green, old probes still green. |
| 4 | Live + bench | 4 live checks, 2 benches; thresholds from the median of repeated runs, in `qwbe.yaml`. | `check --live --bench` green locally. |
| 5 | Switch and delete | CI on the new path; delete `probes/`, `scripts/*.mjs`, `probe:all`, sizecaps, the SQLite to PG tool. | CI green on the new path (needs CI re-enabled, owner decision 12). |
| 6 | Core | `Config` service, `@effect/*` upgrade, pack contract review, `core/src` tests off `node:test`. | Owner sign-off per item (proposed; the plan names no stop condition here). |

## Facts checked for this map

- `git ls-files probes | wc -l` = **74**. The table below covers all 74.
- Old line counts come from `wc -l`. New line counts are targets, not measurements.
- `core/tools/` and `core/checks/` do not exist yet.
- `diskDrift` lives in `web/lib/drift.ts:4`, not in core. `shapeOf` lives in
  `core/src/cubes/staging/shapes.ts:38`.
- `core/src/customfields-runtime.test.ts:26` builds the path `probes/fixtures/vault-pack` in code, so
  moving the fixture also changes that line.

Rules for every new file: Effect (`Effect.gen`, Layers, `Data.TaggedError`, strict Schema for YAML,
`Command` from `@effect/platform`, `@effect/vitest`), no new `.mjs`, one purpose per file, around 100
lines or less, Jev score above 70. No check writes to the git tree: plugins, store and data live
only in scoped temp directories (`QWBE_PLUGINS_DIR`, `QWBE_STORE_DIR`, `QWBE_DATA_DIR`). Two tools
read git without changing it (`untracked.ts` with `git ls-files`, the `secrets` gate with
`gitleaks git`); both are allowed.

## 1. probes/ (74 files, 8302 lines)

Prefixes: `T/` = `core/tools/`, `C/` = `core/checks/`. DROP reasons cite the coverage found by test
title; test bodies were not reread.

| # | old file | lines | destination | reason / note |
|---|---|---|---|---|
| 1 | lib.mjs | 227 | `C/_layers/test-db.ts`, `C/_layers/live-server.ts`, `C/_layers/api-client.ts` | helpers split into Layers; `makeScore` goes away (vitest reports) |
| 2 | admin-restart.mjs | 106 | `C/live/admin-restart.test.ts` | opt-in, slow; starts `T/dev.ts` instead of `scripts/start.mjs` |
| 3 | agent-surface.mjs | 187 | part 3 in `C/live/boot-smoke.test.ts`; parts 1-2 DROP | 1-2 covered by `cube-contract.test.ts:59`, `:95`; today it moves `core/plugins` (touches the tree) |
| 4 | auth-logout.mjs | 51 | DROP | `cubes/auth/index.test.ts:96` |
| 5 | booktags.mjs | 128 | `C/integration/hierarchy.test.ts` | reduced to parent mask, child switched off alone, setting via bus |
| 6 | booktags-fixtures.mjs | 95 | `C/integration/hierarchy.test.ts` | planted schema becomes test setup |
| 7 | booktags-detail-fixtures.mjs | 53 | `C/integration/hierarchy.test.ts` | semantic 404 only; 401/403 are in `entity-enforcement.test.ts:62` |
| 8 | booktags-migration.mjs | 117 | `C/integration/migration-preflight.test.ts` | DB only, no boot |
| 9 | booktags-migration-ownership.mjs | 130 | DROP | `migrate-ownership.test.ts:54`, `:84`, `:103`; today it writes to `core/src/cubes` |
| 10 | booktags-migration-ledger.mjs | 188 | `C/unit/ledger-guard.test.ts` | corrupt, wrong shape and snapshot have no test today |
| 11 | pg-scratch.mjs | 49 | `C/_layers/test-db.ts` | twin of `core/src/pg/test-db.ts` |
| 12 | pg-clean.mjs | 35 | `T/db.ts` (`clean` command) | adds the missing `qwbe_booktags_` prefix; not a check |
| 13 | check-command.mjs | 251 | `C/live/qwbe-check-bin.test.ts` | only 1 green + 1 red; the rules are in `check-package.test.ts` |
| 14 | contract.mjs | 162 | `C/unit/api-inventory.test.ts` + `C/integration/api-auth-matrix.test.ts` | inventory separate from the 401 matrix |
| 15 | contract-inventory.mjs | 72 | `C/unit/api-operations.ts` | data: the reviewed list of operations |
| 16 | contract-validator.mjs | 134 | DROP | Effect Schema decode in `C/_layers/api-client.ts` |
| 17 | cube-metadata.mjs | 152 | "404 without permission" in `C/integration/api-auth-matrix.test.ts`; rest DROP | `metadata.test.ts`, `schema-drift.test.ts`; needs `crm/contracts`, absent from the repo |
| 18 | cube-metadata-fixture.mjs | 71 | DROP | leaves with 17 |
| 19 | customfields.mjs | 128 | `C/integration/customfields-persist.test.ts` | runtime rebuilt on the same database instead of a real restart |
| 20 | customfields-walk.mjs | 133 | `C/integration/customfields-persist.test.ts` | phase 1 reduced; the rest is in `custom-values.test.ts`, `customfields/logic.test.ts` |
| 21 | customfields-orphan.mjs | 58 | `C/integration/customfields-persist.test.ts` | the orphan after the definition is deleted |
| 22 | decoupling.mjs | 195 | `C/integration/discovery-no-registry.test.ts` | on a temp `QWBE_PLUGINS_DIR`; today it writes to `core/src/cubes` |
| 23 | decoupling-fixtures.mjs | 78 | `C/integration/discovery-no-registry.test.ts` | SHA fingerprints become test setup |
| 24 | decoupling-removal.mjs | 122 | absence via `QWBE_MOUNTED` in `C/live/boot-smoke.test.ts`; name grep DROP | today it deletes `core/src/cubes/notes`; depcruise covers imports |
| 25 | drift.mjs | 121 | `web/lib/drift.test.ts` | unit on `diskDrift`, which lives in `web/` (decision 6) |
| 26 | drift-store.mjs | 42 | `web/lib/drift.test.ts` | the shelf with a rival becomes test data |
| 27 | external-auth.mjs | 190 | CORS in `C/integration/cors.test.ts`; rest DROP | token and allowlist parsing: `origins.test.ts:9-71`, `auth/index.test.ts:71`, `:96` |
| 28 | install.mjs | 174 | `C/integration/install-guard.test.ts` | on temp `QWBE_PLUGINS_DIR` + `QWBE_STORE_DIR`; today it deletes notes through the API |
| 29 | install-store.mjs | 78 | `C/integration/install-guard.test.ts` | store planted in the temp directory |
| 30 | install-writes.mjs | 118 | `C/integration/install-guard.test.ts` | name collision and `requiresRestart` have no test today |
| 31 | install-refusals.mjs | 118 | `C/integration/install-guard.test.ts` | traversal over HTTP; the permission wall is in `settings/index.test.ts:113` |
| 32 | install-from.mjs | 175 | `C/unit/install-from-refusals.test.ts` | the kernel function directly, no HTTP |
| 33 | install-from-fixtures.mjs | 151 | source table in `C/unit/install-from-refusals.test.ts`; bookmarks copy in `C/_layers/pack-copy.ts` | `:29-49` duplicates `lifecycle-bench.mjs`; one copy remains |
| 34 | install-from-life.mjs | 150 | `C/live/package-lifecycle.test.ts` | pending drift and the remove-add-remove cycle |
| 35 | install-from-attacks.mjs | 71 | `C/unit/install-from-refusals.test.ts` | symlink, FIFO, phantom, edited shelf: table rows |
| 36 | lifecycle.mjs | 79 | `C/live/package-lifecycle.test.ts` | one pass, not two |
| 37 | lifecycle-bench.mjs | 100 | `C/_layers/pack-copy.ts` | the renamed copy of bookmarks |
| 38 | lifecycle-life.mjs | 145 | `C/live/package-lifecycle.test.ts` | install, restart, uninstall, restart steps |
| 39 | list.mjs | 282 | `C/bench/list-60k.bench.ts` | correctness is in `kernel/list.test.ts:24-130`; timing remains, with a threshold |
| 40 | permissions.mjs | 160 | DROP | `entity-enforcement.test.ts`, `permissions/index.test.ts:111-198`, `sharing.test.ts` |
| 41 | permissions-bypass-scenario.mjs | 16 | DROP | `entity-enforcement.test.ts:62`, `:95` |
| 42 | permissions-capabilities-scenario.mjs | 93 | DROP | `capability-gates.test.ts:198-373` |
| 43 | permissions-visibility-scenario.mjs | 72 | DROP | `permissions/index.test.ts:169`, `:181`, `:198` |
| 44 | restart.mjs | 77 | DROP | proves nothing now: each boot gets a new database (`lib.mjs:131-136`), ids are random |
| 45 | security.mjs | 108 | `C/integration/api-auth-matrix.test.ts` + `C/unit/policy-reader-no-write.test.ts` | fake/empty token, switched-off cube = nonexistent |
| 46 | security-boundaries.mjs | 103 | reader rule in `C/unit/policy-reader-no-write.test.ts`; 404 in `C/integration/api-auth-matrix.test.ts` | |
| 47 | security-cli.mjs | 98 | `C/unit/policy-reader-no-write.test.ts` (arity, prototype names) | ported: `cli/index.test.ts` covers neither (decision 13) |
| 48 | security-injection.mjs | 139 | "no hash in responses" in `C/integration/api-auth-matrix.test.ts`; rest DROP | `pagination.test.ts:86-92`, `list.test.ts:116`, `store.test.ts:58` |
| 49 | security-manifest.mjs | 77 | DROP | `kernel/manifest.test.ts:42`, `:86`, `:141`, `:148`; `kernel/store.test.ts:31` |
| 50 | size-lib.mjs | 71 | DROP | the repo size gate goes (plan); `package-size.ts` stays until stage 6 |
| 51 | size-guards.mjs | 99 | DROP | same |
| 52 | sizecaps.mjs | 200 | DROP | same |
| 53 | sizecaps-baseline.mjs | 158 | DROP | same; also looks broken today (imports `package-size.ts` from a copied tree) |
| 54 | smoke-cli.mjs | 99 | `C/live/boot-smoke.test.ts` | a single on/off switch |
| 55 | smoke-tags.mjs | 38 | `C/integration/hierarchy.test.ts` | the second cube and the relation in the space |
| 56 | smoke.mjs | 164 | `C/live/boot-smoke.test.ts` | the only check that boots `main.ts` from login to logout |
| 57 | staging.mjs | 160 | `C/integration/staging-shapes.test.ts` | only the agreement of JS `shapeOf` with SQL `~` on Postgres |
| 58 | staging-life.mjs | 92 | DROP | `staging/parse.test.ts:68`, `profile.test.ts:72` |
| 59 | staging-proofs.mjs | 116 | DROP | `staging/parse.test.ts:49`, `:92`, `:138`; `profile.test.ts:67`, `:72` |
| 60 | staging-perf.mjs | 95 | `C/bench/staging-pg.bench.ts` | import + 100k profile; gets a threshold |
| 61 | store.mjs | 60 | `C/live/boot-smoke.test.ts` | one GET on the empty shelf |
| 62 | store-isolation.mjs | 140 | `C/integration/pg-grants.test.ts` | the test role is dropped in a finalizer (today it stays in the cluster) |
| 63 | store-migration.mjs | 115 | DROP | the SQLite to PG tool is dropped (owner decision 1) |
| 64 | store-drift.mjs | 134 | DROP | `store-drift.test.ts:34-81` covers all 5 cases |
| 65 | testgate.mjs | 123 | `T/testgate.ts` | a gate, not a check; the `untested` list comes from `qwbe.yaml` |
| 66 | untracked.mjs | 100 | `T/untracked.ts` | gate; reads `git ls-files`, does not write |
| 67 | views.mjs | 151 | DROP | known-red today (decision 14); covered by `integration/views-auth.test.ts:114`, `cubes/views/index.test.ts:30-94` |
| 68 | fixtures/guestbook-pack/qwbe-package.json | 6 | `C/_fixtures/guestbook-pack/` (moved unchanged) | used by 19-21 |
| 69 | fixtures/guestbook-pack/cubes/guestbook/index.ts | 121 | same | |
| 70 | fixtures/guestbook-pack/cubes/guestbook/index.test.ts | 20 | same, stays on `node:test` | a pack's test, required by the pack contract, not by qwbe |
| 71 | fixtures/vault-pack/qwbe-package.json | 6 | `C/_fixtures/vault-pack/` | changes the path in `customfields-runtime.test.ts:26` |
| 72 | fixtures/vault-pack/cubes/vault/index.ts | 126 | same | |
| 73 | fixtures/permission-bypass/qwbe-package.json | 6 | DROP | only `permissions.mjs` used it |
| 74 | fixtures/permission-bypass/cubes/hostile/index.ts | 43 | DROP | `entity-enforcement.test.ts:17` has its own hostile cube |

Row count: 45 go into new checks or Layers (merged, some only in part), 21 whole DROP (including
sizecaps x 4, permission-bypass x 2 and store-migration), 5 fixtures moved, 2 gates, 1 tool command.
Total 74. No row is undecided.

## 2. scripts/, core/scripts/ and the root

| # | old file | lines | destination | reason / note |
|---|---|---|---|---|
| 1 | scripts/check.mjs | 105 | `T/check.ts` | runs every gate without stopping at the first red (unlike agent-run2; a requirement stated in `check.mjs`) |
| 2 | scripts/check-gates.mjs | 135 | `T/check.ts` (gate list) | the summary regexes DROP: the verdict is the exit code |
| 3 | scripts/typecheck-web.mjs | 50 | `T/check.ts` (`typecheck:web` gate, two commands) | |
| 4 | scripts/check-ascii.mjs | 140 | DROP | the owner removed the ASCII rule in agent-run2 |
| 5 | scripts/check-branch.mjs | 93 | DROP | no branch protection on `main` today; CI re-enable is open (owner decision 12) |
| 6 | scripts/generate-compliance.mjs | 55 | DROP | SBOM and notices go |
| 7 | scripts/setup.mjs | 116 | `T/setup.ts` (Effect) | the shell variant is not enough (decision 15) |
| 8 | scripts/start.mjs | 217 | `T/dev-ports.ts` + `T/dev.ts` | keeps the restart on exit 0 (the admin restart mechanism); split per decision 18 |
| 9 | core/scripts/build-assets.mjs | 24 | `T/build.ts` | `tsc` + copy migrations; `prepack` calls it |
| 10 | screenshots.mjs | 166 | DROP | owner decision; not in CI, not a gate |
| 11 | screenshots-lib.mjs | 114 | DROP | same |
| 12 | .husky/pre-commit | 71 | DROP; secretlint + gitleaks in the `secrets` gate of `T/check.ts` and in CI | secret scanning lives only here today: moving it is mandatory in stage 2 |
| 13 | .husky/commit-msg | 50 | DROP | |
| 14 | .lintstagedrc.json | 3 | DROP | `biome check` runs in the `lint` gate |
| 15 | sbom.spdx.json | 3478 | DROP | generated |
| 16 | THIRD_PARTY_NOTICES.md | 392 | DROP | generated; a technical judgment, not a legal one |
| 17 | core/qwbe.config.json | 22+ | `untestedBaseline` into `qwbe.yaml`; `baseline` DROP with sizecaps; the caps stay for `package-size.ts` until stage 6 | |
| 18 | qwbe.spec.mjs | 396 | STAYS | a Playwright test; `T/e2e.ts` runs it |
| 19 | playwright.config.mjs | 17 | STAYS | the shape Playwright requires |
| 20 | eslint.config.mjs | n/a | STAYS | the kernel uses it when installing a pack (`install-contract.ts:17-18`) |

Today's npm scripts map to `T/check.ts` (`check`, `check:strict`, `test`, `lint`, `typecheck*`,
`boundaries`, `secrets`, `verify`), `T/dev.ts` (`start`, `api`, `web`), `T/db.ts` (`db:up`,
`db:down`), `T/e2e.ts` (`e2e`), `T/build.ts` (core `build`), `T/setup.ts` (`setup`). The 26
`probe:*` scripts and `probe:all` leave in stage 5; in stage 2 `restart`, `admin-restart` and the
other probes that write to the tree leave `probe:all`.

## 3. New files

All need `NodeContext.layer` (FileSystem, Path, CommandExecutor). "vitest" means vitest's per-test
duration report, no threshold. Blocking thresholds only on `list-60k` and `staging-pg`, from the
median of repeated runs, in `qwbe.yaml`, run only with `check --bench`.

### core/tools/

| path | purpose | lines | Layer / service | benchmark |
|---|---|---|---|---|
| `core/tools/process.ts` | Runs a command with argv, returns code, stdout, stderr; typed `GateFailed`. | 35 | `Command`, CommandExecutor | no |
| `core/tools/process.test.ts` | Non-zero code, large output without a pipe stall. | 45 | `it.layer(NodeContext.layer)` | vitest |
| `core/tools/config.ts` | Reads `qwbe.yaml` with strict Schema; `ConfigInvalid` names file, path, value. | 55 | FileSystem, `yaml`, Schema | no |
| `core/tools/config.test.ts` | Unknown key, duplicate key, wrong value give `ConfigInvalid`. | 40 | `it.layer`, temp directory | vitest |
| `core/tools/check.ts` | Runs every gate, PASS/FAIL per gate, exit 1 at the end; `--strict`, `--live`, `--bench` from argv. | 55 | `process.ts`, `config.ts` | no |
| `core/tools/check.test.ts` | Fake `package.json` in a temp directory: all run, one red gives exit 1. | 50 | `it.layer`, `makeTempDirectoryScoped` | vitest |
| `core/tools/testgate.ts` | Every cube has a test; the `untested` list from `qwbe.yaml`, ignored with `--strict`. | 45 | FileSystem, `config.ts` | no |
| `core/tools/testgate.test.ts` | A cube without a test fails, a listed cube passes, `--strict` catches it. | 35 | `it.layer`, temp directory | vitest |
| `core/tools/untracked.ts` | Everything that mounts appears in `git ls-files`. | 35 | `process.ts` (git, read only) | no |
| `core/tools/dev-ports.ts` | Reads dev ports from `qwbe.yaml` and checks they are free before start. | 40 | `config.ts`, `net` | no |
| `core/tools/dev.ts` | Process supervision: starts API and web with line prefixes, restarts the API on exit 0, stops children when the scope closes. | 60 | `Command`, Scope, `dev-ports.ts` | no; behavior proven by `live/admin-restart.test.ts` |
| `core/tools/db.ts` | `up`/`down` via docker compose; `clean` drops leaked test databases. | 45 | `process.ts`, `pg` | no |
| `core/tools/build.ts` | `tsc -p tsconfig.build.json` and copy `src/pg/migrations` into `dist/`. | 20 | `process.ts`, FileSystem | no |
| `core/tools/e2e.ts` | Build web with `NEXT_PUBLIC_QWBE_API`, then `playwright test`. | 30 | `process.ts` | no |
| `core/tools/bench-budget.ts` | Runs `vitest bench --outputJson`, decodes the result, compares `median` with the threshold in `qwbe.yaml`. | 50 | `process.ts`, `config.ts`, Schema; `BenchOverBudget` | applies the thresholds |
| `core/tools/setup.ts` | Checks Node >= 22.18.0 with a clear message, strips `npm_config_allow_scripts` in any case, `npm ci --no-audit --no-fund` in root, `core`, `web` (stop at first error), creates `data/` or `$QWBE_DATA_DIR`. | 50 | `process.ts`, FileSystem | no |

`setup.ts` runs before `core/node_modules` exists on a fresh clone; how it is bootstrapped (for
example a root `effect` dev dependency installed first) is settled in stage 2.

### core/checks/

| path | purpose | lines | Layer / service | benchmark |
|---|---|---|---|---|
| `core/checks/_layers/test-db.ts` | One Postgres database per test; the finalizer runs `DROP ... WITH (FORCE)` and drops created roles. | 50 | `TestDb` (`Layer.scoped`), `pg` | no |
| `core/checks/_layers/test-kernel.ts` | The in-process app (`HttpApiBuilder.toWebHandler`) over `TestDb`, with temp directories for plugins, store, data. | 60 | `TestKernel`, needs `TestDb` | no |
| `core/checks/_layers/live-server.ts` | Starts `main.ts` on a free port, waits for the first response, SIGTERM on exit. | 55 | `LiveServer` (`Layer.scoped`), `Command`, `TestDb` | time to ready, reported |
| `core/checks/_layers/api-client.ts` | `HttpClient` with responses decoded by Schema, over the in-process handler or a port. | 40 | `Api`, `HttpClient` | no |
| `core/checks/_layers/pack-copy.ts` | A renamed copy of bookmarks in a temp plugins directory. | 35 | FileSystem, Scope | no |
| `core/checks/unit/api-operations.ts` | Data: the reviewed list of published operations. | 65 | none | no |
| `core/checks/unit/api-inventory.test.ts` | Published operations = the list; all except login declare bearer and 401. | 40 | OpenAPI built without boot (decision 8) | vitest |
| `core/checks/unit/ledger-guard.test.ts` | Missing, corrupt, wrong-shape or rewritten ledger gives a typed refusal, schema untouched. | 40 | FileSystem, temp directory | vitest |
| `core/checks/unit/install-from-refusals.test.ts` | Table of bad sources (symlink, FIFO, phantom, lying manifest...), all `InstallError`, store empty. | 50 | FileSystem, `Command` for `mkfifo` | vitest |
| `core/checks/unit/policy-reader-no-write.test.ts` | No manifest gives `:write` to reader; the CLI dispatcher refuses extra arguments and prototype names. | 30 | none | vitest |
| `core/checks/integration/api-auth-matrix.test.ts` | Every protected route gives the declared 401; fake/empty token gives 401; switched-off cube = nonexistent; metadata without permission = 404; no hash. | 70 | `TestKernel`, `Api` | vitest |
| `core/checks/integration/cors.test.ts` | A listed origin is echoed, an unlisted one is not, a single entry filters the same, no `Origin` works. | 30 | `TestKernel` | vitest |
| `core/checks/integration/migration-preflight.test.ts` | A conflict on the second migration renames nothing; a clean migration moves the row; a second run is a no-op. | 40 | `TestDb` | vitest |
| `core/checks/integration/hierarchy.test.ts` | Parent off gives children 404; child off alone; the setting reaches the sibling; the plugin's second cube answers. | 60 | `TestKernel`, `Api` | vitest |
| `core/checks/integration/customfields-persist.test.ts` | The value sits in the target row, survives a runtime rebuild, deleting the definition leaves an orphan. | 50 | `TestKernel` + guestbook from `_fixtures` | vitest |
| `core/checks/integration/install-guard.test.ts` | Install does not mount and asks for restart; name collision refused; undo; traversal refused; required cubes cannot be deleted. | 60 | `TestKernel`, `Api` | vitest |
| `core/checks/integration/discovery-no-registry.test.ts` | A cube placed in the plugins directory appears in catalog, OpenAPI, permissions, CLI; no existing file changes. | 45 | `TestKernel`, `pack-copy` | vitest |
| `core/checks/integration/pg-grants.test.ts` | The engine refuses role A the table of B; the app login cannot read outbox and migrations. | 45 | `TestDb` | vitest |
| `core/checks/integration/staging-shapes.test.ts` | JS `shapeOf` and SQL `~` give the same shapes on the same set. | 35 | `TestDb` | vitest |
| `core/checks/live/boot-smoke.test.ts` | `main.ts` starts, login, each base cube, empty shelf 200, one switch, logout; with `QWBE_MOUNTED` without notes it also starts. | 50 | `LiveServer` x 2, `Api` | time to first 401 |
| `core/checks/live/package-lifecycle.test.ts` | Install, restart (mounted), uninstall (server stays up), restart (404, login OK). | 70 | `LiveServer` x 3, `pack-copy` | time per boot |
| `core/checks/live/qwbe-check-bin.test.ts` | The real bin: a clean pack gives exit 0 with 4 stages, a red probe gives exit 1 and is named. | 50 | `Command`, temp directory | total duration |
| `core/checks/live/admin-restart.test.ts` | Restart under `T/dev.ts`: the API comes back, web stays up. Opt-in. | 60 | `Command` (`dev.ts`), `Api` | recovery time |
| `core/checks/bench/list-60k.bench.ts` | On 60k rows, the deep page and the SQL filter cost as much as the top page. | 50 | `TestDb`, store directly | **threshold**: page 300 < max(250 ms, 4 x page 1), any response < 1000 ms (today's thresholds from `list.mjs:213-222`), confirmed from the median |
| `core/checks/bench/staging-pg.bench.ts` | Import and profile on 100k rows. | 40 | `TestDb`, `TestKernel` | **threshold**: rows/s >= median of the reference run (no threshold today) |

### Other files

| path | purpose | lines | Layer / service | benchmark |
|---|---|---|---|---|
| `qwbe.yaml` | `version`, dev ports, `untested` list, thresholds for the two benches. | 15 | read by `config.ts` | holds the thresholds |
| `web/lib/drift.test.ts` | `diskDrift` names exactly the missing cube; an uninstalled rival is not drift. | 30 | none | `node:test` (decision 6) |

Also: `core/checks/_fixtures/` receives the 5 fixture files moved unchanged (279 lines), and
`core/package.json` gets `vitest@3.2.7`, `@effect/vitest@0.30.0`, `yaml` as dev dependencies. The
vitest config sets `isolate: true` explicitly (decision 9).

## Totals

| | files | lines |
|---|---|---|
| old, code that leaves or is ported (probes 69 without the moved fixtures, scripts 8, core/scripts 1, screenshots 2, husky 2, lint-staged 1) | 83 | 9362 |
| old, generated (SBOM, notices) | 2 | 3870 |
| **total old** | **85** | **13232** |
| new: core/tools | 16 | 690 |
| new: core/checks (_layers 5, unit 5, integration 9, live 4, bench 2) | 25 | 1220 |
| new: `qwbe.yaml`, `web/lib/drift.test.ts` | 2 | 45 |
| **total new** | **43** | **~1955** (targets) |
| moved unchanged (`_fixtures`) | 5 | 279 |
| left untouched (`qwbe.spec.mjs`, `playwright.config.mjs`) | 2 | 413 |

Old: 8302 (probes) - 279 (moved fixtures) + 911 (scripts) + 24 + 280 + 121 + 3 = 9362.

New core/tools: the earlier draft had 14 files / 640 lines. `dev.ts` (100) splits into
`dev-ports.ts` (40) + `dev.ts` (60), and `setup.ts` (50) is added: 16 files / 690 lines.
New core/checks: the row sum is 1220; the earlier draft said 1175, which was an addition error.

Also deleted in stage 5, outside these totals: `core/src/migrate-sqlite-to-pg.ts` and
`migrate-proof.ts` (owner decision 1).

## Owner decisions

1. **SQLite to PG tool: DROP.** `store-migration.mjs`, `core/src/migrate-sqlite-to-pg.ts` and
   `migrate-proof.ts` leave in stage 5. Assumption: no live SQLite store checked on the lab machine
   (unverified).
2. **Screenshots: DROP.** `screenshots.mjs` and `screenshots-lib.mjs` leave in stage 5.
3. **newId** is fixed separately (12 random bytes) in PR #38, outside this plan.
12. **Re-enabling CI is an open owner decision.** Recorded 2026-09-26: no branch protection on
    `main`; the GitHub workflow `verify` is `disabled_manually`; its last run on `main` was on
    25 Aug; PRs #15 to #37 ran without CI. Until CI is back, stage 2 stops on local green.

Owner rule of 2026-09-26: **Jev score above 70 on every new file.** Line counts above are targets
sized for that rule; scores are measured when each file is written.

## Shepherd decisions

Numbers follow the 18 open points of the draft map. Evidence is `file:line` in this repo or a
command result from 2026-09-26.

4. **`@effect/vitest` 0.30.0 with `vitest` 3.2.7, no `@effect/*` upgrade.** Peers of 0.30.0:
   `effect ^3.22.0`, `vitest ^3.2.0`; installed `effect` is 3.22.1. `npm i --strict-peer-deps` with
   those versions exited 0 in a scratch project, and an `it.effect` test passed (1 passed).
   vitest `latest` (5.x) is outside the peer range.
5. **Tests in `core/src` stay on `node:test`** until stage 6. `T/check.ts` runs both runners
   (`node --test` and `vitest`).
6. **`web/lib/drift.test.ts` on `node:test`**, like the other web tests. Web is not Effect; the
   same exception as `glimpse/` in agent-run2, until a web stage.
7. **`core/checks/_fixtures/` is adopted.** The only `core/src` user is `vault-pack`, at
   `core/src/customfields-runtime.test.ts:26`; that path changes when the fixture moves.
   `core/src/kernel/manifest.test.ts:239` names `permission-bypass` only in a comment.
8. **`api-inventory` is a unit check.** OpenAPI builds without boot: `buildApi` at
   `core/src/runtime-composition.ts:128` touches no DB or network, `OpenApi.fromApi` at
   `core/src/main.ts:197`; read, not run. The test sets a temp `QWBE_DATA_DIR`, because `mount`
   may write `switches.json` (`core/src/kernel/state.ts:108-110`). One `buildApi` per test file:
   groups are module singletons (`core/src/capability-gates.test.ts:44-45`).
9. **Env read at import.** The vitest config sets `isolate: true` explicitly. Scratch run: with
   `isolate: true` each file sees its own env set before a dynamic `import()`, on forks and threads;
   with `isolate: false` and one worker the second file sees the first file's value. Import-time
   reads: `core/src/kernel/ledger.ts:31` (`QWBE_DATA_DIR`), `core/src/kernel/state.ts:21`
   (`QWBE_DATA_DIR`), `core/src/kernel/scan.ts:34` (`QWBE_PLUGINS_DIR`),
   `core/src/kernel/install-parts.ts:23` (`QWBE_PLUGINS_DIR`), `core/src/kernel/install.ts:65`
   (`QWBE_STORE_DIR`), `core/src/main.ts:37` (`QWBE_PORT`), `core/src/main.ts:46`
   (`QWBE_ALLOWED_ORIGINS`); inherited through `core/src/package-contract.ts:19` (imports
   `pluginsDir`). `core/src/metadata/schema-drift.ts:21` is lazy (a function), not an import-time
   read. A `Config` service replaces these in stage 6.
10. **Bench format.** `vitest bench --outputJson` (3.2.7) has `median` in ms, plus `p75`, `p99`,
    `p995`, `p999`; no `p50`. Source: `node_modules/vitest/dist/runners.js:57-59`. `bench-budget.ts`
    compares `median`.
11. **Thresholds** for `list-60k` and `staging-pg` come from reference runs in stage 4;
    `list-60k` starts from `probes/list.mjs:213-222`.
13. **`security-cli` is ported** into `policy-reader-no-write`. `core/src/cubes/cli/index.test.ts`
    covers neither extra arguments nor prototype names: its stub (`index.test.ts:36-39`) never
    returns `TooManyArgs`. The kernel dispatcher at `core/src/kernel/discovery.ts:237-262` has no
    test (grep on `*.test.ts` for `TooManyArgs`, `maxArgs`, `.invoke(`: zero).
14. **`cube-metadata.mjs` and `views.mjs`: DROP, as known-red, not regressions.** Observed
    2026-09-26 locally: `probes/views.mjs` exit 1 (`TypeError: score.exit is not a function`,
    `views.mjs:151`); `probes/cube-metadata.mjs` exit 1 (server refused to boot: migration ledger
    has no record of "bookmarks"). Stage 2 "old green" excludes both.
15. **`setup.mjs` ports to `core/tools/setup.ts` (Effect).** The shell variant
    (`env -u npm_config_allow_scripts` + `engine-strict` in `.npmrc`) is not enough: it does not
    create `data/`; it misses `NPM_CONFIG_ALLOW_SCRIPTS` in upper case (scratch run on npm 12.0.2:
    `EALLOWSCRIPTS`, exit 1); a root `.npmrc` does not reach `core/` and `web/` outside `npm run`
    (`cd sub && npm ci` only warned `EBADENGINE`, exit 0); `env -u` and `sh` do not exist on
    Windows. Counted above: +1 file.
16. **Pack probes are out of scope.** Probes in `probes/` are repo tooling. Pack probes live in
    the plugin repos and stay `.mjs` under the pack contract (`core/src/check-package.ts:141-143`,
    refusal of `.ts` fixed by `core/src/check-package.test.ts:81-88`). This plan does not touch
    them; any contract change is stage 6.
17. **References cleaned in stage 5:** `README.md:102-114`, `:176`, `:340`, `:401`,
    `docs/package-contract.md`, comments in `core/src` that name probes (for example
    `pg/setup.ts:12`, `kernel/store.ts:8`, `cubes/views/index.ts:8`),
    `core/.dependency-cruiser.cjs:173`, `core/qwbe.config.json:21`.
18. **`dev.ts` splits** into `dev-ports.ts` (ports: read from `qwbe.yaml`, check free) and `dev.ts`
    (process supervision: start, prefix, restart on exit 0, stop on scope close), so each stays
    small enough for the Jev rule.
19. **`setup` bootstraps through `core/tools/bootstrap.mjs`** (stdlib, 17 lines). If
    `core/node_modules/effect` is missing it runs `npm ci --no-audit --no-fund` in `core` with
    `npm_config_allow_scripts` dropped in any case, then runs `node tools/setup.ts`. No root
    `effect` dependency and no lockfile change. Cost: on a fresh clone `core` installs twice, and
    `setup.ts` reinstalls `core` while running from it (modules are already loaded). Node older than
    22.18 cannot load `setup.ts`, so its version message shows only under `--experimental-strip-types`
    on 22.6-22.17. The old tool stays as `npm run setup:old`.

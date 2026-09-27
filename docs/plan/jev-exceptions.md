# Jev scores under 70 after stages 2-5 (documented exceptions)

Measured 2026-09-26 ~21:40 with `agents jev--code-skill score <files> --skill ponytail,unslop,lucian,codebase-design`
on the 72 new files of core/tools, core/checks (fixtures excluded), web/lib/drift.test.ts and the vitest configs.
42 files have at least one score under 70; 62 of 288 scores are under 70.
The owner accepted these as exceptions to fix in a later refactor. Rescore with the command above; Jev varies about 1.5 points
between runs of the same file.

Pattern seen on this branch: splitting code into many small exports raises `lucian` (single responsibility) and lowers
`codebase-design` (depth, pass-through); merging does the reverse. Test files and vitest configs score low on
`codebase-design`, a rubric written for modules.

| file | scores under 70 |
|---|---|
| `core/checks/_layers/postgres.ts` | codebase-design 50.8 |
| `core/checks/bench/staging-pg.bench.ts` | codebase-design 55.7, lucian 65.9, ponytail 68.6 |
| `core/tools/e2e.ts` | codebase-design 56.9 |
| `core/checks/bench/list-60k.bench.ts` | codebase-design 57.8, lucian 63.8 |
| `core/checks/integration/staging-shapes.test.ts` | codebase-design 58.8, ponytail 66.5 |
| `core/vitest.bench.config.ts` | codebase-design 59.0 |
| `core/tools/build.ts` | codebase-design 59.8 |
| `core/checks/integration/migration-preflight.test.ts` | codebase-design 59.9 |
| `core/vitest.config.ts` | codebase-design 59.9 |
| `core/tools/bootstrap.mjs` | codebase-design 60.0, lucian 67.5 |
| `core/checks/live/admin-restart.test.ts` | codebase-design 60.4, ponytail 68.7, lucian 69.0 |
| `core/tools/db-pure.ts` | codebase-design 60.5 |
| `core/checks/_layers/session.ts` | codebase-design 60.8 |
| `core/checks/unit/ledger-guard.test.ts` | codebase-design 61.1 |
| `core/tools/dev-supervise.ts` | lucian 61.5 |
| `core/tools/gates.ts` | codebase-design 61.5 |
| `core/tools/dev.ts` | lucian 61.8, codebase-design 68.3 |
| `core/vitest.live.config.ts` | codebase-design 61.9 |
| `core/checks/live/package-lifecycle.test.ts` | codebase-design 62.3, lucian 68.5 |
| `core/checks/integration/pg-grants.test.ts` | codebase-design 63.4, lucian 66.3 |
| `core/checks/integration/api-auth-matrix.test.ts` | codebase-design 63.5, lucian 69.0 |
| `core/tools/setup.ts` | codebase-design 63.8, lucian 65.4, ponytail 69.5 |
| `core/checks/live/qwbe-check-bin.test.ts` | codebase-design 64.7, lucian 65.5, ponytail 67.2 |
| `core/checks/integration/customfields-persist.test.ts` | lucian 64.9, codebase-design 66.0 |
| `core/checks/unit/install-from-refusals.test.ts` | codebase-design 65.1 |
| `core/checks/bench/client.ts` | codebase-design 65.2 |
| `core/tools/setup-pure.ts` | codebase-design 65.2 |
| `core/tools/run-tool.ts` | lucian 66.0 |
| `core/checks/live/boot-smoke.test.ts` | codebase-design 66.1, lucian 68.3 |
| `core/tools/bench-budget.ts` | lucian 66.5 |
| `core/checks/unit/policy-reader-no-write.test.ts` | codebase-design 66.7, lucian 69.5 |
| `core/checks/_layers/boot.ts` | lucian 66.8 |
| `core/checks/integration/discovery-no-registry.test.ts` | codebase-design 67.1 |
| `core/tools/db-clean.ts` | ponytail 67.1 |
| `core/checks/integration/install-guard.test.ts` | codebase-design 67.2 |
| `core/tools/db.ts` | codebase-design 67.3, lucian 69.3 |
| `core/tools/dev-pure.ts` | codebase-design 67.8 |
| `core/checks/unit/api-operations.ts` | codebase-design 67.9 |
| `core/checks/integration/cors.test.ts` | codebase-design 68.4 |
| `core/checks/unit/temp-env.ts` | lucian 68.5, codebase-design 69.2 |
| `core/checks/_layers/pack-copy.ts` | lucian 68.6 |
| `core/checks/integration/hierarchy.test.ts` | codebase-design 68.7 |

## Stage 6 (core on EVE / Pi with GLM 5.3), 2026-09-27

Scored with `agents jev--score-run <run_id>` (journal `~/.local/state/agent-run2/jev`, read by
Glimpse II), on the changed lines only. Test migration (runs 9330ef92, 75784498, 486cffba, wiring
863b547d, all `glm-pi` on `sub/glm-5.3-flash`): 201 scores on 67 files, median 85.9, 5 under 70.
The changed lines are one import swap per file; the owner's rule for this stage is to record, not
refactor, what stays under 70.

| file | scores under 70 |
|---|---|
| `core/src/customfields-runtime.test.ts` | lucian 57.9, ponytail 65.4 |
| `core/src/install-contract.test.ts` | lucian 64.4 |
| `core/src/pg/echo-activity-pg.test.ts` | lucian 65.2 |
| `core/src/kernel/state.test.ts` | lucian 69.9 |

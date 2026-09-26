# Jev score exceptions

Owner rule (2026-09-26): every new file scores above 70 on the Jev rubrics `ponytail`, `unslop`,
`lucian` and `codebase-design`. The files below stay under 70 on one rubric. The owner decided on
2026-09-26 to keep them as exceptions and review them after the whole cleanup is done.

Scored with `agents jev--code-skill score <file> --skill ponytail,unslop,lucian,codebase-design`;
two runs of the same file differ by up to about 1.5 points.

| file | rubric | score | why it stays |
|---|---|---|---|
| `core/tools/check.ts` | lucian | 65.8, 66.8 | entry point that wires config, gate list and exit code; the 2026-09-19 SRP lab measured 60 to 80 as the ceiling for such files |
| `core/tools/check.ts` | codebase-design | 68.7, 69.2 | same file; it is a thin composition root, so "depth" stays low |
| `core/vitest.config.ts` | codebase-design | 63.3, 63.1 | five-line framework config; there is nothing to deepen |
| `core/tools/report.ts` | codebase-design | 69.7, 69.5 | three small pure text functions; merging them into `gate.ts` would lower `lucian` there (91.1 here) |

## Stage 3 checks (core/checks), scored 2026-09-26

Most entries are `codebase-design` on test files: that rubric judges module depth and interfaces,
which a test file does not have. The `_layers` entries are real modules and the first to revisit.

| file | rubric | score |
|---|---|---|
| `core/checks/_layers/api-client.ts` | codebase-design | 62.5 |
| `core/checks/_layers/api-client.ts` | lucian | 66.9 |
| `core/checks/_layers/boot.ts` | lucian | 53.7 |
| `core/checks/_layers/pack-copy.ts` | lucian | 59.9 |
| `core/checks/_layers/pack-copy.ts` | ponytail | 65.9 |
| `core/checks/integration/api-auth-matrix.test.ts` | codebase-design | 63.2 |
| `core/checks/integration/cors.test.ts` | codebase-design | 67.3 |
| `core/checks/integration/customfields-persist.test.ts` | codebase-design | 62.7 |
| `core/checks/integration/discovery-no-registry.test.ts` | codebase-design | 68.0 |
| `core/checks/integration/discovery-no-registry.test.ts` | lucian | 66.8 |
| `core/checks/integration/hierarchy.test.ts` | codebase-design | 58.5 |
| `core/checks/integration/install-guard.test.ts` | codebase-design | 66.1 |
| `core/checks/integration/migration-preflight.test.ts` | codebase-design | 60.5 |
| `core/checks/integration/pg-grants.test.ts` | codebase-design | 63.8 |
| `core/checks/integration/pg-grants.test.ts` | lucian | 69.8 |
| `core/checks/integration/pg-grants.test.ts` | ponytail | 69.3 |
| `core/checks/integration/staging-shapes.test.ts` | codebase-design | 64.8 |
| `core/checks/integration/staging-shapes.test.ts` | lucian | 65.4 |
| `core/checks/integration/staging-shapes.test.ts` | ponytail | 68.3 |
| `core/checks/live/boot-smoke.test.ts` | codebase-design | 61.3 |
| `core/checks/live/package-lifecycle.test.ts` | codebase-design | 56.4 |
| `core/checks/live/package-lifecycle.test.ts` | lucian | 66.7 |
| `core/checks/unit/api-inventory.test.ts` | codebase-design | 65.5 |
| `core/checks/unit/api-inventory.test.ts` | lucian | 63.5 |
| `core/checks/unit/api-operations.ts` | codebase-design | 57.1 |
| `core/checks/unit/install-from-refusals.test.ts` | codebase-design | 63.4 |
| `core/checks/unit/ledger-guard.test.ts` | codebase-design | 65.6 |
| `core/checks/unit/policy-reader-no-write.test.ts` | codebase-design | 65.6 |
| `core/checks/unit/policy-reader-no-write.test.ts` | lucian | 60.8 |

Revisit when stage 6 is done.

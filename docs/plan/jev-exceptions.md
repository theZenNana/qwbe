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

Revisit when stage 6 is done.

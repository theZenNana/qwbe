# Stage 6 - review of `docs/package-contract.md` against the code

Scope: the pack contract document (`docs/package-contract.md`) checked line by line against
`core/src/package-contract.ts`, `core/src/package-contract-scan.ts`, `core/src/check-package.ts`,
`core/src/package-size.ts`, `core/src/kernel/install.ts` / `install-from.ts` / `install-parts.ts`,
`core/src/install-contract.ts`, `core/src/kernel/discovery.ts`, `core/package.json`,
`core/qwbe.config.json`, and the sibling pack repos under `plugins/`
(read only). One table, then a short section per `decision for the owner`. No code changed.

| # | finding | evidence (file:line) | status |
|---|---------|----------------------|--------|
| 1 | `kind` is NOT "read by nothing else today": the installer requires it (`cube` or `plugin`, absence refused) and uses it to choose the package layout (`plugin`: `cubes` list + `cubes/<name>/` dirs; `cube`: standalone root `index.ts`, `cubes` ignored). The doc sentence "Declared and validated, read by nothing else today" is factually wrong. | `core/src/kernel/install.ts:183-187,193-200`; doc `docs/package-contract.md` §1 | fixed in the doc |
| 2 | Checker and installer disagree on `kind`: the checker accepts any non-empty string (or absence); the installer accepts only `cube`/`plugin` and demands `kind`. Also the checker requires `manifest.cubes` to be an array unconditionally, which a `kind: "cube"` package has no reason to declare. Whether the checker should mirror the installer (and whether standalone `cube` packages are a supported pack shape at all) is a contract change. | `core/src/package-contract-scan.ts:92-99` (name), `:96` (kind non-empty string), `:112-118` (cubes must be array); `core/src/kernel/install.ts:183-187` | decision for the owner |
| 3 | The doc's public-subpath enumeration omits `/list` (`qwbe-core/list` exists and is exported). The sentence "the list lives in `core/package.json` `exports`" is right; the parenthetical list is wrong. | `core/package.json:51-54` (`./list` -> `src/list-contracts.ts`); doc `docs/package-contract.md` §2 | fixed in the doc |
| 4 | The doc names `plugins/agents-tools` as a sibling checkout holding the `source-contract.test.mjs` model. It is not a sibling checkout: it lives archived (checkout `agents-tools`, kept out of the repo). The only sibling using `checkPackageSource` is `plugins/crm-pack` (`source-contract.test.mjs` calls it with `{ hierarchy: true }`). `plugins/activegraph/test/source-contract.test.mjs` exists but is hand-rolled and does not call the checker. | `plugins/` contains only `activegraph`, `crm-pack`, `qwbe-integrations`; `plugins/crm-pack/source-contract.test.mjs:10,15`; `plugins/activegraph/test/source-contract.test.mjs:1-20` (asserts on source text, no `checkPackageSource`); doc `docs/package-contract.md` §4 | fixed in the doc |
| 5 | The doc says the dependency-cruiser rule allows "no module in the kernel to import `package-contract` except its own test and the boot gate in `kernel/discovery.ts`". The rule also excepts `src/check-package.ts` (`qwbe check`), which the doc's list misses. | `core/.dependency-cruiser.cjs:134-137` (`pathNot` includes `^src/check-package\.ts$`, comment "the qwbe check command may import package-contract"); doc `docs/package-contract.md` §7 | fixed in the doc |
| 6 | Runtime probes must be `*.mjs` and at least one is required: missing `probes/` or no `*.mjs` fails the runtime stage. The doc never states the `*.mjs` requirement (it only cites crm-pack's `probes/crm.mjs` as the model). Accepting `*.ts` would be additive (backwards compatible): probes are spawned with plain `node`, and node 22.22 strips types without flags; under an installed kernel they additionally get `--conditions=qwbe-dist`, which only affects `qwbe-core/*` resolution, not type stripping. Whether to admit `*.ts` probes is a contract change. | `core/src/check-package.ts:127-152` (`probesFindings`: filter `f.endsWith(".mjs")`, "a package must carry at least one runtime probe (*.mjs)"); `core/src/check-package.ts:286-299` (spawn of each probe, `--conditions=qwbe-dist` when installed); `plugins/crm-pack/probes/crm.mjs:1-17` (probe boots its own scratch server, model) | decision for the owner |
| 7 | The doc's test story ("unit tests per cube, run by `npm test` in the pack") is contradicted by the checker's own invocation stage: `scripts.test` must be exactly `"qwbe check ."` and a pack must depend on an installed (not `file:`/`link:`) `qwbe-core`. Reality is a third thing: crm-pack's `scripts.test` is `node --test ...` and its dependency is `file:../../qwbe/core`. Doc, checker and the shipped pack all disagree; which one is the rule is a contract change, not a doc typo. | `core/src/check-package.ts:385-440` (`invocationFindings`: "scripts.test must be exactly \"qwbe check .\""; `file:` dependency refused); `plugins/crm-pack/package.json` `scripts.test` and `dependencies["qwbe-core"]`; doc `docs/package-contract.md` §4 | decision for the owner |
| 8 | Test runner for packs: the doc names no runner, correctly. Core's own `src/**/*.test.ts` moved to vitest (`vitest.config.ts` includes `src/**`), but packs keep `node:test` (crm-pack's `source-contract.test.mjs` imports `node:test`; `vitest.config.ts` comments "core/plugins are packs: their own tests run on node:test"). Nothing in the doc needs to change for a pack. | `core/vitest.config.ts:1-13`; `plugins/crm-pack/source-contract.test.mjs:4-7`; README fix done separately (line 127 said core/src tests were "still on node:test") | no change |
| 9 | Size caps: the doc is right. Caps live in `core/qwbe.config.json` (50000 chars/file, 50000 chars + 15 files/unit, `countMode: code`), and `qwbe check` reads them from the *installed kernel's* config. They should NOT move to `qwbe.yaml`: `qwbe.config.json` ships in the kernel tarball (`package.json` `files`), while root `qwbe.yaml` is dev config never published; a pack under `qwbe check` against an npm install could not read a yaml cap. | `core/qwbe.config.json:1-14` ("Ships in the kernel tarball, which is why it is not in the root qwbe.yaml"); `core/package.json:9-15` (`files` includes `qwbe.config.json`); `core/src/check-package.ts:56-73` (`kernelCaps` reads `kernelRoot()/qwbe.config.json`); `core/src/package-size.ts:143-160` (`capsFromConfig`) | no change |
| 10 | Boot gate verified as documented: `loadDefinitions` calls `assertPackageContracts(mounting)` before the first plugin `import()`, without `hierarchy` (text-only, no foreign execution); a finding throws and `main.ts` exits with code 2. Store fallback for an installed manifest confirmed (`manifestRootFor` -> `QWBE_STORE_DIR` or `plugins/../store`). | `core/src/kernel/discovery.ts:96-99`; `core/src/package-contract.ts:146-176` (`assertPackageContracts`, no `hierarchy`); `core/src/package-contract.ts:136-151` (`manifestRootFor`); `core/src/main.ts:65` (`failAfterSnapshot(e, 2)`) | no change |
| 11 | Rule inventory verified as documented: builtin deny-list matches the doc word for word (`fs`, `fs/promises`, `child_process`, `worker_threads`, `module`, `vm`, `sqlite`, `net`, `http`, with and without `node:`); skip sets match (dotted dirs + `node_modules` at any depth; `frontend`, `probes`, `store`, `dist`, `build` at top level only; nested `frontend/` inside a cube is ordinary source for both checker and size gate); test files are exempt from `cube-builtins` and the readOnly rules but not from `imports-internal`. | `core/src/package-contract-scan.ts:32-41` (`BUILTIN_ROOTS`, `SKIP_DIRECTORIES`, `SOURCE_FILE`, `TEST_FILE`); `core/src/package-contract-scan.ts:66-76` (`walkSources` depth rules); `core/src/package-contract-scan.ts:79-107` (`imports-internal` applies to all files, `cube-builtins` skips tests); `core/src/package-contract-scan.ts:111-141` (readOnly exemptions); `core/src/package-size.ts:14-25,52-60` (size walk, top-level `frontend` only) | no change |
| 12 | Caps numbers, no baseline, and the dropped kernel self-gate verified: 50000/50000/15 in `qwbe.config.json`; `sizeCapsFindings` reports anything over cap; stage-1-map line 98 dropped the repo size gate and kept `package-size.ts` "until stage 6" (this review). | `core/qwbe.config.json:9-13`; `core/src/package-size.ts:166-196`; `docs/plan/stage-1-map.md:98` | no change |

## Decisions for the owner

### #2 - Should the checker accept the same `kind` values the installer accepts?

Today the checker accepts any non-empty `kind` (or none) while the installer refuses anything
but `cube`/`plugin`, requires `kind`, and gives `kind: "cube"` a completely different layout
(root `index.ts`, `cubes` ignored) that the checker's mandatory `manifest.cubes` array would
reject anyway. Proposal: make the checker enforce what the installer enforces - `kind` present
and equal to `cube` or `plugin` - and decide explicitly whether a standalone `cube` package is
a shape packs may ship; if it is, the checker's manifest rule needs a `kind`-aware branch, and
if it is not, the installer should refuse `kind: "cube"` from `install-from` and the doc should
say packs are plugins only. Rejecting the change keeps two validators that answer differently
to the same manifest, with the boot gate trusting the lenient one.

### #6 - Must runtime probes be `*.mjs`? Would `*.ts` be backwards compatible?

The runtime stage only counts `probes/*.mjs`; a probe written in TypeScript is invisible to it.
Accepting `*.ts` is additive: existing `*.mjs` probes keep working, and node 22.22 runs `.ts`
directly (the same reason the kernel boots `src/main.ts`); the `--conditions=qwbe-dist` flag
the checker adds under an install affects only `qwbe-core/*` resolution, not type stripping.
Proposal: widen `probesFindings` to `*.mjs` or `*.ts`. Rejecting it keeps probes locked to
plain JavaScript, which costs a pack nothing today but means the doc's model probe language and
the checker's filter must stay in sync by hand.

### #7 - Which test story is the rule: `npm test`, or `qwbe check .`?

Three answers exist: the doc says unit tests run by `npm test`; the checker's invocation stage
demands `scripts.test` be exactly `"qwbe check ."` with an installed (not `file:`) `qwbe-core`
dependency; the shipped pack does `node --test ...` against a `file:` dependency and would fail
its own invocation stage if it ever ran `qwbe check`. Proposal: pick one and make the other two
match. If `qwbe check .` is the rule, the doc gains a short section on the invocation stage and
crm-pack is a work item; if `npm test` with node:test is the rule, `invocationFindings` should
loosen. Rejecting any change keeps the checker's stage 4 a rule no shipped pack satisfies, and
a pack author reading the doc will ship the third, unjudged variant.

## Already fixed in the doc while reviewing (rows 1, 3, 4, 5)

Each fix is the smallest sentence change that makes the doc match the code; nothing else in the
touched paragraphs moved.

## Check

`npx biome check docs/plan/stage-6-contract-review.md` - biome ignores markdown here; its real
output was "These paths were provided but ignored: docs/plan/stage-6-contract-review.md", so
the markdown check is skipped per the brief's fallback.

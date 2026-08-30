# The Qwbe package contract

One page, read whole, and you can write and verify a pack without opening the kernel.
The shared checker lives in qwbe and is exported as **`qwbe-core/package`**
(source: `core/src/package-contract.ts` + `core/src/package-contract-scan.ts`). A pack
runs it from its own directory and gets a list of findings -- each one a `{ rule, file,
message }`. No findings means the package keeps its side of the contract.

```js
import { checkPackageSource } from "qwbe-core/package"
const findings = await checkPackageSource(import.meta.dirname, { readOnly: false, hierarchy: false })
```

Everything below skips a top-level `frontend/` directory in a package. The pack's UI is
judged by the browser build, not by the cube contract -- not by this checker, not by the
size gate (`probes/size-lib.mjs` skips `frontend/` too).

## 1. The manifest

`qwbe-package.json` sits at the package root, next to `cubes/`:

```json
{ "name": "crm-pack", "kind": "plugin", "cubes": ["crm", "crm/contacts", "crm/contracts"] }
```

- `name` -- the package slug. Under the `hierarchy` option, each cube's manifest must also
  carry the same name as its path (`crm/contacts` declares `"contacts"`).
- `kind` -- when present, a non-empty string (the packs use `"plugin"`). Declared and
  validated, read by nothing else today.
- `cubes` -- every cube the package ships, as the kernel addresses them: a standalone cube
  is one segment (`crm`), a child is `parent/child` (`crm/contacts`). The declared list
  must match the disk exactly, in both directions: a declared cube without
  `cubes/<name>/index.ts` installs air; an undeclared directory installs unreviewed code.
  The checker enforces both (rule `manifest`).

## 2. Allowed imports

- A cube reaches qwbe **only through public `qwbe-core/*` subpaths** -- the list lives in
  `core/package.json` `exports` (`qwbe-core/cube`, `/agent`, `/http`, `/auth`, `/entity`,
  `/errors`, `/pagination`, `/permissions`, `/package`). Anything reaching
  `../../src/...` or `qwbe-core/src/...` pins the pack to one kernel checkout and breaks
  the moment the kernel moves (rule `imports-internal`).
- A cube imports **no** `node:fs`, `node:fs/promises`, `node:child_process`,
  `node:worker_threads`, `node:module`, `node:vm`, `node:sqlite` (rule `cube-builtins`).
  Only import lines are inspected, so a comment explaining the rule does not trip it. A
  cube reads through the platform services the kernel lends it; the filesystem is the
  kernel's, not the cube's.

## 3. Size caps

Caps are characters, not lines, measured with comments stripped -- the numbers and the
baseline live in `qwbe.config.json`, the gate is `npm run probe:sizecaps`
(`probes/sizecaps.mjs`). Caps: 6000 chars per file, 40000 chars
and 15 files per unit; a unit is one cube directory, a space, or the kernel.

Existing violations are recorded in `qwbe.config.json` as a **baseline**: the gate is red
for anything NEW or anything that GREW past its recorded number; the inherited debt is
printed every run. The fix for an over-cap file is to split it, never to raise the number
-- raising is a visible diff to `qwbe.config.json`, done after the split, on purpose.

## 4. Tests and probes a pack must ship

- Unit tests per cube, run by `npm test` in the pack. A cube without tests is a work-queue
  entry in qwbe's own gate (`probes/testgate.mjs`); a pack should not need reminding.
- The source-contract check: a test file that calls `checkPackageSource` with the pack's
  options and asserts zero findings. See the `source-contract.test.mjs` at the root of the
  `plugins/crm-pack` and `plugins/agents-tools` repositories (sibling checkouts of this one)
  for the whole pattern.
- A runtime probe that boots the kernel on a scratch directory and attacks the installed
  cube over HTTP (crm-pack's `probes/crm.mjs` is the model).
- Two optional rule sets, on by the pack that needs them:
  - `readOnly` -- no mutating endpoint (`HttpApiEndpoint.post/put/patch/del`) and no
    `writeFile`/`appendFile` in package source (rules `readonly-endpoint`, `readonly-write`).
    Exemptions, on purpose: `*.test.*` and `*.spec.*` files (a test's job is to name the
    forbidden thing), and the top-level `probes/`, `store/`, `dist/` and `build/` directories.
    For packs that only read.
  - `hierarchy` -- child cubes declare `parent`, the parent declares `screen: true`, and
    every child declares `dataMigration` (rule `hierarchy`). For parent/child packs.

## 5. How install-from installs a pack

`core/src/kernel/install-from.ts` is the one door through which the kernel accepts a
directory it did not build. It requires an absolute, real (symlink-free) path; nothing in
the tree may be a symlink, socket, device or fifo; nothing is executed from the source.
The tree is fingerprinted (`core/src/package-source.ts`), staged into the store under
`core/store/`, and the staged copy -- not your checkout -- is what runs. The contract gate
(`core/src/install-contract.ts`) then typechecks and lints the staged copy in isolation:
a package that does not typecheck breaks after install, the worst moment to find out.
After staging, the shelf copy belongs to the store; uninstalling removes the destination,
not the shelf.

## 6. What the contract ignores

`frontend/` at the top level of a package: skipped by the checker's scan, skipped by the
size gate. Bring your own build for it; the kernel never looks inside. A `frontend/`
nested deeper -- inside a cube -- is ordinary source: judged, and capped.

## 7. The one place the checker executes pack code

With the `hierarchy` option, `core/src/package-contract.ts` imports each cube's `index.ts`
to read the manifest it exports -- and importing a module runs its top-level code, from a
caller-supplied directory. Execution is genuinely required: the manifests are runtime
exports, not text, and parsing them back out of source would be a second, drift-prone
statement of what a manifest is. The compensating pin is in the boundary graph:
dependency-cruiser rule `package-contract-is-the-pack-door` (`core/.dependency-cruiser.cjs`)
allows no module in the kernel to import `package-contract` except its own test. If kernel
code ever needs the checker, that rule is the visible place to argue it.

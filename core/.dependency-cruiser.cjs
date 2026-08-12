// Boundaries, checked against the real import graph — not with a regex over source text.
//
// A regex-based check has two problems: it only
// catches literal names, and a third party cannot extend it without editing it — which makes
// the enforcement itself one more foreign file a new cube has to touch.
//
// Dependency-cruiser's own `from`/`to` rule model expresses the boundary directly. The
// backreference lets imports inside one unit pass while imports into another unit fail.
//
// Rules 2, 3 and 4 are the ones that keep discovery honest: if the kernel, `main.ts`, or a
// plugin could import a cube, a name would be written down somewhere, and a central list of
// cubes is exactly what was removed.

module.exports = {
  forbidden: [
    {
      name: "no-cube-to-cube",
      comment:
        "A cube does not import another cube. Another cube's data comes through the registry; " +
        "events go on the bus; the link between two cubes is declared in a space; commands go " +
        "through the CLI registry. All four travel by string, so none of them show up in this " +
        "graph — which is precisely why an import here would be the only real coupling.",
      severity: "error",
      from: { path: "^src/cubes/([^/]+)/" },
      to: {
        path: "^src/cubes/([^/]+)/",
        pathNot: ["^src/cubes/$1/"],
      },
    },
    {
      name: "no-plugin-to-cube",
      comment:
        "A plugin's cube may not import a core cube either. Plugins get the kernel and nothing " +
        "else — same rules as everyone, no privileges for arriving later.",
      severity: "error",
      from: { path: "^plugins/" },
      to: { path: "^src/cubes/" },
    },
    {
      name: "kernel-knows-no-cube",
      comment:
        "The kernel imports no cube. If it did, it would know a cube's name — and from there to " +
        "a central list is one step. Cubes are discovered from disk at runtime.",
      severity: "error",
      from: { path: "^src/kernel/" },
      to: { path: "^src/cubes/|^plugins/" },
    },
    {
      name: "main-knows-no-cube",
      comment: "Nor does main.ts. Central registration would require a hand-written catalogue of every cube.",
      severity: "error",
      from: { path: "^src/main\\.ts$" },
      to: { path: "^src/cubes/|^plugins/" },
    },
    {
      name: "space-imports-no-cube",
      comment:
        "A space declares connections BETWEEN cubes, so it must not import either side. If it " +
        "did, deleting a cube would break the space at load time instead of producing a warning.",
      severity: "error",
      from: { path: "^src/spaces/" },
      to: { path: "^src/cubes/|^plugins/" },
    },
    {
      // Added after an adversarial review walked straight through the store isolation: a cube
      // imported `storeFor` from the kernel and built itself a store for another cube's tables.
      // depcruise reported no violations, because nothing forbade cube → kernel internals.
      name: "cubes-may-not-build-their-own-store",
      comment:
        "A cube receives its store from the kernel through `create({ store })`. Importing the " +
        "store factory lets it construct one for tables it does not own — which is the whole " +
        "isolation, bypassed in one line.",
      severity: "error",
      from: { path: "^src/cubes/|^plugins/" },
      to: { path: "^src/kernel/(store|discovery|state)\\.ts$" },
    },
    {
      // The short way round the previous rule: skip the kernel entirely and open the file.
      // `QWBE_DATA_DIR` is in the environment, so the path is not a secret.
      name: "cubes-may-not-touch-storage-directly",
      comment:
        "A cube has no business opening a database or the filesystem. Its data arrives through " +
        "its store; another cube's data arrives through the registry. Both are given to it.",
      severity: "error",
      // A plugin's `setup.mjs` is not a cube: it is the plugin's own installer, run by the
      // operator through `npm run setup`, and its whole job is spawning the toolchain the
      // plugin brings (an interpreter, a package manager). The rule keeps guarding what a
      // CUBE'S code may reach at request time -- `cubes/<name>/` and everything a cube
      // imports -- not the operator-facing script that only exists to prepare an environment.
      from: { path: "^src/cubes/|^plugins/", pathNot: ["^plugins/[^/]+/setup\\.mjs$"] },
      // Both spellings on purpose. A first attempt matched only `node:`-prefixed names and let
      // `node:fs` through anyway — depcruise reports some builtins bare — so the rule was
      // written, tested with a deliberate violation, and found to be half-open. Now each of the
      // three attacks (kernel store factory, node:sqlite, node:fs) is verified to be rejected.
      // `node:module` and `node:vm` are on the list because they are the ways back in:
      // `createRequire(...)("node:fs")` and `vm.runInThisContext` both reach the filesystem
      // without ever naming it.
      //
      // WHAT THIS CANNOT CATCH, and it is the boundary of the whole approach:
      //
      //     const m = "node:" + "fs"
      //     await import(m)          // invisible to any static analysis, by construction
      //
      // Verified, not assumed: a literal `await import("node:fs")` IS caught; the computed
      // version is not. No boundary tool can see it, which is precisely why the comment at the
      // top of `store.ts` says lint rather than sandbox. A real barrier is a separate process.
      to: { path: "^(node:)?(sqlite|fs|fs/promises|child_process|worker_threads|module|vm)$" },
    },
    {
      name: "no-circular",
      comment: "Composable blocks, not tangles.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "A file nobody imports and which is not an entry point is dead.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "^src/main\\.ts$",
          "^src/cubes/[^/]+/index\\.ts$",
          "^plugins/[^/]+/cubes/[^/]+/index\\.ts$",
          "^src/spaces/[^/]+/index\\.ts$",
        ],
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}

// Thin, type-aware ESLint layer — ported from software-factory (D15).
//
// ESLint NEVER formats here. Biome owns formatting and cleanliness; `tsc --noEmit` owns
// correctness. This config runs only the handful of rules that need full type information and
// that Biome does not cover:
//
//   - @typescript-eslint/no-floating-promises  (needs the type checker)
//   - @typescript-eslint/no-misused-promises   (needs the type checker)
//   - @effect/no-import-from-barrel-package    (the only non-formatting rule @effect ships)
//
// Honest note, carried over from factory: @effect/eslint-plugin does NOT catch unhandled or
// floating Effects — tsc does. The plugin is here for the barrel-import rule and nothing else.
//
// Why floating promises matter in THIS repository specifically: the kernel discovers cubes with
// dynamic `import()`, installs packages by copying directories, and restarts the server. Every
// one of those is a promise that, unawaited, finishes after the thing that needed it — the class
// of bug where a cube is "installed" and the catalogue still does not have it.

import effect from "@effect/eslint-plugin"
import tseslint from "typescript-eslint"

export default tseslint.config(
  // .mjs is out of scope: the probes are plain node scripts with no tsconfig behind them, so a
  // type-aware rule cannot run on them at all. web/ is excluded until it gets its own project
  // service — its tsconfig is Next's, and pulling it in here would typecheck the whole app twice.
  //
  // `core/plugins/*` and `core/store/*` hold INSTALLED and STAGED packages -- artifacts, not
  // kernel source. Walking them made the repo-wide lint red exactly when the system was in use:
  // every file of an installed pack belongs to no kernel tsconfig project, so the type-aware
  // parser refuses it ("was not found by the project service"), 18 errors on one installed pack
  // and none of them about this repository's code. A gate that is green only while nothing is
  // installed is not a gate.
  //
  // Those files are not going unchecked. A pack is linted where it lives (its own repository
  // mirrors these rules), and the kernel lints it again AT INSTALL: `install-contract.ts` copies
  // the package into `core/src/qwbe-contract-*` and runs this same config over it with
  // `--no-ignore`, which is the path that refused three real findings on 2026-08-31. `--no-ignore`
  // means the exclusion below cannot blind that gate -- verified by installing a pack with a
  // deliberate violation after this line was written.
  //
  // `example-plugin` is the exception because it is not an artifact: it is committed kernel
  // source, the in-tree demo pack, and it must stay linted.
  {
    ignores: [
      "**/*.mjs",
      "**/*.cjs",
      "web/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/generated/**",
      "core/store/**",
      // Every installed package EXCEPT the in-tree demo. A plain `core/plugins/**` plus a
      // negation does not work: once ESLint ignores a directory it does not descend into it, so
      // the re-include never fires. The extglob names the packs to skip in one pattern instead.
      "core/plugins/!(example-plugin)/**",
    ],
  },
  {
    files: ["core/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "@effect": effect,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@effect/no-import-from-barrel-package": "error",
    },
  },
  // `describe()` and `it()` from node:test RETURN promises, and the runner is what awaits them —
  // awaiting them by hand is not how the API is used. Left on, the rule reported 79 of its 82
  // findings inside the five test files, which is how a linter teaches people to stop reading it.
  // The rule stays on everywhere else, where a floating promise is a real bug.
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
  {
    files: ["core/src/runtime-composition.ts"],
    rules: {
      // Runtime discovery makes the concrete HttpApi group union unknowable. This is the one
      // audited erasure adapter; cube contracts are typed and runtime-validated before entry.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
)

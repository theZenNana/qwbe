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
  {
    ignores: ["**/*.mjs", "**/*.cjs", "web/**", "**/node_modules/**", "**/.next/**", "**/dist/**", "**/generated/**"],
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
    },
  },
)

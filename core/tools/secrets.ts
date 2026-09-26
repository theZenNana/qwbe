import * as Effect from "effect/Effect"
import { commands } from "./gate.ts"
import { gitLines } from "./git.ts"

const GITLEAKS = ["gitleaks", "git", ".", "--log-opts=origin/main..HEAD", "--no-banner"] as const

/** secretlint on tracked files only (local scratch git ignores never leaves the machine), then gitleaks. */
export const secretProblems = (root: string) =>
  gitLines(root, "ls-files").pipe(
    Effect.flatMap((files) => commands(root, ["npx", "secretlint", ...files], GITLEAKS)),
    Effect.catchAll((error) => Effect.succeed([String(error)])),
  )

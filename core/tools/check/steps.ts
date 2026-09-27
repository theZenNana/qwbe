import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { FileSystem } from "@effect/platform/FileSystem"
import * as Effect from "effect/Effect"
import { type Argv, capture, captureLines } from "../shared/process.ts"
import { commandName } from "../shared/process-pure.ts"
import { benchFindings } from "./bench-budget.ts"
import { testgate } from "./testgate.ts"
import { untracked } from "./untracked.ts"

// A step is a command to run, or the tag of a check that runs in this process.
export type Step = Argv | "testgate" | "untracked" | "secretlint" | "bench"

const commandFindings = (root: string, argv: Argv) =>
  Effect.map(capture(argv, root), ({ status, stdout, stderr }) =>
    status === 0 ? [] : [`${commandName(argv)} exited ${status}\n${stdout}${stderr}`],
  )

// Tracked files only: ignored local scratch is not ours to scan.
const secretlintTracked = (root: string) =>
  Effect.flatMap(captureLines(["git", "ls-files"], root), (files) =>
    commandFindings(root, ["npx", "--no-install", "secretlint", ...files]),
  )

const named = (label: string) => (units: ReadonlyArray<string>) => units.map((unit) => `${label}: ${unit}`)

// `excused` holds the units allowed to lack tests.
const stepFindings = (
  root: string,
  excused: ReadonlyArray<string>,
  step: Step,
): Effect.Effect<ReadonlyArray<string>, { readonly message: string }, CommandExecutor | FileSystem> => {
  switch (step) {
    case "testgate":
      return Effect.map(testgate(root, excused), named("no unit tests"))
    case "untracked":
      return Effect.map(untracked(root), named("mounts but is not in git"))
    case "secretlint":
      return secretlintTracked(root)
    case "bench":
      return benchFindings(root)
    default:
      return commandFindings(root, step)
  }
}

// Every step runs even after one fails, so one red step never hides the next.
export const gateFindings = (root: string, excused: ReadonlyArray<string>, steps: ReadonlyArray<Step>) =>
  Effect.map(
    Effect.forEach(steps, (step) => stepFindings(root, excused, step)),
    (lists) => lists.flat(),
  )

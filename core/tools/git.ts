import * as Command from "@effect/platform/Command"
import * as Effect from "effect/Effect"
import { capture } from "./process.ts"

/** The non-empty output lines of one read-only git command run in `root`. */
export const gitLines = (root: string, ...args: string[]) =>
  capture(Command.make("git", ...args).pipe(Command.workingDirectory(root))).pipe(
    Effect.map(({ stdout }) => stdout.split("\n").filter(Boolean)),
  )

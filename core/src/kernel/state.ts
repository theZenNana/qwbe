// The on/off switches. The state lives in the kernel, but it is ADMINISTERED by an ordinary
// cube (`settings`), not by the kernel.
//
// Why not simply keep it inside the settings cube: the kernel must consult the state BEFORE
// dispatch, so a disabled cube returns 404 without touching authentication or any handler. If
// the state lived in the settings cube's database, the kernel would have to read one cube's
// data — the exact thing cubes are forbidden. A rule cannot carve out an exception for whoever
// enforces it; at that point it stops being a rule.
//
// So the state belongs to the kernel, and WRITE access is granted as a privilege DECLARED in
// the manifest (`managesCubes: true`). At most one cube may hold it, checked at mount. This is
// A module may receive an external dependency only when declared at install
// time rather than reaching for it in code. A declared hatch, not a hidden one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Effect } from "effect"

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")
const stateFile = join(dataDir, "switches.json")

/** Disabled cubes. Anything absent is enabled — so a newly installed cube starts alive. */
const readDisabled = (): Set<string> => {
  if (!existsSync(stateFile)) return new Set()
  try {
    return new Set((JSON.parse(readFileSync(stateFile, "utf8")) as { disabled?: Array<string> }).disabled ?? [])
  } catch {
    return new Set()
  }
}

const writeDisabled = (disabled: Set<string>): void => {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  writeFileSync(stateFile, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, "utf8")
}

// Tagged, not `extends Error`: the caller discriminates on `_tag` instead of parsing a string,
// and the compiler lists what `set` can refuse. The wording is unchanged — it is what the user
// reads in the UI, and it already says what was refused and why.
export class RequiredCubeError extends Data.TaggedError("RequiredCubeError")<{
  readonly cube: string
  readonly message: string
}> {
  static for = (cube: string): RequiredCubeError =>
    new RequiredCubeError({
      cube,
      message:
        `Cube "${cube}" is required and cannot be switched off. ` +
        `Without it the system could not be brought back from the UI — a button that cuts the ` +
        `branch it sits on.`,
    })
}

export class UnknownCubeError extends Data.TaggedError("UnknownCubeError")<{
  readonly cube: string
  readonly message: string
}> {
  static for = (cube: string, mounted: ReadonlyArray<string>): UnknownCubeError =>
    new UnknownCubeError({ cube, message: `Cube "${cube}" is not mounted. Mounted now: [${mounted.join(", ")}].` })
}

// A disk that refuses the write is not the caller's fault, so it travels as its own failure
// rather than being folded into "bad request". Separate tag, separate decision at the edge.
export class StateFileError extends Data.TaggedError("StateFileError")<{
  readonly path: string
  readonly message: string
}> {}

export type Switches = {
  /**
   * Pure on purpose, and it stays that way: the kernel asks this before every dispatch, on the
   * bus and in the middleware. The state it reads is already in memory — wrapping it in an
   * Effect would buy nothing and would push a `yield*` into three hot paths.
   */
  readonly isEnabled: (cube: string) => boolean
  readonly list: () => ReadonlyArray<{
    readonly name: string
    readonly enabled: boolean
    readonly required: boolean
  }>
  /** Writes to disk and can refuse — so it says both in the type instead of throwing. */
  readonly set: (
    cube: string,
    enabled: boolean,
  ) => Effect.Effect<void, RequiredCubeError | UnknownCubeError | StateFileError>
}

export const switchesFrom = (
  mounted: ReadonlyArray<{ readonly name: string; readonly required: boolean }>,
): Switches => {
  let disabled = readDisabled()
  const known = new Map(mounted.map((m) => [m.name, m]))

  // A cube that was switched off and has since been removed from disk has no business staying
  // in the file — otherwise the disabled list grows ghosts forever.
  const cleaned = new Set([...disabled].filter((n) => known.has(n)))
  if (cleaned.size !== disabled.size) {
    disabled = cleaned
    writeDisabled(disabled)
  }

  return {
    isEnabled: (cube) => known.has(cube) && !disabled.has(cube),

    list: () => mounted.map((m) => ({ name: m.name, enabled: !disabled.has(m.name), required: m.required })),

    set: (cube, enabled) =>
      Effect.gen(function* () {
        const m = known.get(cube)
        if (!m) return yield* Effect.fail(UnknownCubeError.for(cube, [...known.keys()]))
        if (m.required && !enabled) return yield* Effect.fail(RequiredCubeError.for(cube))

        // The in-memory set is changed only after the write succeeds — otherwise a failed write
        // leaves the running system saying "off" while the file still says "on", and the next
        // boot silently undoes what the user just did.
        const next = new Set(disabled)
        if (enabled) next.delete(cube)
        else next.add(cube)

        yield* Effect.try({
          try: () => writeDisabled(next),
          catch: (e) => new StateFileError({ path: stateFile, message: (e as Error).message }),
        })
        disabled = next
      }),
  }
}

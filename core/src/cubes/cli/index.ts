// The CLI cube — a gate that runs commands, callable from the web.
//
// It knows no command of its own. Every cube declares its commands in `create`, the kernel
// aggregates them exactly as it aggregates permissions, and this cube just dispatches. Adding a
// command means adding a line to your own cube; nothing here changes, and nothing here has to
// learn a new name.
//
// Two things are enforced at the gate, and both are the reason a "run anything" endpoint is
// safe to expose at all:
//
//   1. Only DECLARED commands run. There is no shell, no eval, no path to arbitrary code — the
//      name is looked up in a map and the matching function is called. An unknown name is an
//      error, never a fallthrough to something else.
//   2. Each command carries its own required permission, checked per call against the caller's
//      effective permissions. A reader running `account:list` gets 403, from the same mechanism
//      that guards every other endpoint.
//
// Arguments arrive as an array of strings and reach only the declared function. Nothing is
// interpolated into a shell, a path, or SQL.

import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { CommandInfo, CommandResult, Invocation } from "../../http-contracts.ts"
import { Authorization, CurrentUser, requirePermission } from "../../kernel/auth-contract.ts"
import { BadRequest, Forbidden } from "../../kernel/errors.ts"

const group = HttpApiGroup.make("cli")
  .add(HttpApiEndpoint.get("commands")`/cli/commands`.addSuccess(Schema.Array(CommandInfo)).addError(Forbidden))
  .add(
    HttpApiEndpoint.post("exec")`/cli/exec`
      .setPayload(Invocation)
      .addSuccess(CommandResult)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .middleware(Authorization)

/**
 * The permission each route requires, declared ONCE (QWB-54, ticket 10): the manifest
 * publishes it through the kernel's metadata and the handlers below check through this same
 * object, so renaming a permission moves enforcement and publication together.
 */
const ROUTES = {
  commands: "cli:read",
  exec: "cli:exec",
} as const

export const cube = defineCube(group, {
  manifest: {
    name: "cli",
    tables: [],
    requiresAuth: true,
    // Declared capability: this is the cube that dispatches commands. The kernel holds the
    // dispatcher and checks each command's permission inside it, so holding this does not mean
    // holding a skeleton key — it means being the one allowed to ask.
    runsCommands: true,
    permissions: [
      { name: "cli:read", roles: ["admin", "reader"] },
      { name: "cli:exec", roles: ["admin", "reader"] },
    ],
    routes: ROUTES,
  },

  // TS2322 care stătea aici a fost REZOLVATĂ pe 9 aug 2026, nu stinsă. Ce era și cum s-a închis,
  // fiindcă întrebarea se pune din nou de fiecare dată când cineva scrie o comandă nouă:
  //
  // `CommandSpec.run` cere `Effect<string, string, never>` — o comandă nu are voie să ceară NIMIC
  // din context. `cli:help` avea totuși nevoie să știe cine întreabă, ca să arate fiecăruia doar
  // comenzile pe care le poate rula; fără filtrare, lista e un inventar de capabilități oferit
  // tocmai cui nu le are. Amândouă corecte separat, imposibile împreună.
  //
  // Ieșirea aleasă: utilizatorul vine ca ARGUMENT, nu din context. Dispecerul din kernel are deja
  // permisiunile apelantului — le verifică înainte să cheme `run` — deci le și dă mai departe.
  // `R` rămâne `never`, contractul rămâne strâns, iar comanda rămâne o funcție pură.
  //
  // Ce s-a respins: lărgirea lui `R` la `CurrentUser`. Ar fi mers pentru `cli:help`, dar odată
  // deschis contractul, ORICE comandă poate cere ORICE serviciu — iar comenzile sunt singura cale
  // dintre cuburi care a scăpat deja o dată capabilitate executabilă (vezi `manifest.ts`).
  //
  // Motivarea completă stă lângă tip, în `kernel/manifest.ts`, nu aici.
  create: ({ commands, runCommands }: CubeTools) => {
    if (!runCommands) {
      // Cannot happen: the manifest asks for it and the kernel grants it on that basis. If it
      // does, failing at startup beats a 500 on the first command.
      throw new Error("cli asked for `runsCommands: true` but received no dispatcher — kernel bug")
    }

    return {
      commands: [
        {
          name: "cli:help",
          summary: "list the commands you may run",
          permission: "cli:read",
          // Filtrat după permisiunile APELANTULUI, care sosesc ca argument de la dispecer. Lista
          // arăta cândva tot, indiferent de cine întreabă — un inventar gratuit de capabilități
          // oferit exact celui care nu le poate folosi.
          run: (_args, callerPermissions) =>
            Effect.succeed(
              commands()
                .filter((c) => callerPermissions.includes(c.permission))
                .map((c) => `${c.name.padEnd(22)} ${c.summary}`)
                .sort()
                .join("\n") || "(no commands you may run)",
            ),
        },
      ],

      handlers: {
        commands: () =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.commands)
            const user = yield* CurrentUser
            return commands()
              .map((c) => ({
                name: c.name,
                summary: c.summary,
                permission: c.permission,
                allowed: user.permissions.includes(c.permission),
              }))
              .sort((a, b) => a.name.localeCompare(b.name))
          }),

        exec: ({ payload }: { payload: { line: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.exec)
            const user = yield* CurrentUser

            const parts = payload.line.trim().split(/\s+/).filter(Boolean)
            const name = parts[0]
            if (!name) return yield* Effect.fail(new BadRequest({ message: "empty command" }))

            // Dispatch, not evaluation — and the dispatcher belongs to the kernel. This cube can
            // no longer reach a command's function, and neither can any other: `commands()` now
            // returns metadata only.
            return yield* runCommands.invoke(name, parts.slice(1), user.permissions).pipe(
              Effect.catchTag("UnknownCommand", () =>
                Effect.fail(
                  new BadRequest({ message: `unknown command "${name}". Run cli:help to see what you may run.` }),
                ),
              ),
              Effect.catchTag("NotAllowed", (e) =>
                Effect.fail(new Forbidden({ message: `"${name}" is not yours to run`, needed: e.permission })),
              ),
              Effect.catchTag("TooManyArgs", (e) =>
                Effect.fail(
                  new BadRequest({
                    message:
                      `"${name}" takes ${e.allowed} argument(s), got ${e.got}. Nothing was run. ` +
                      `There is no shell here — "&&", ";" and "|" are not operators, just extra arguments.`,
                  }),
                ),
              ),
            )
          }),
      },
    }
  },
})

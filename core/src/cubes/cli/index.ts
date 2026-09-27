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
import { requireTool } from "../shared.ts"

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

// Route permissions, published by the metadata and checked by the handlers (see metadata/declarations.ts).
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

  // The TS2322 that sat here was FIXED on 9 Aug 2026, not silenced. What it was and how it closed,
  // because the question comes back every time someone writes a new command:
  //
  // `CommandSpec.run` requires `Effect<string, string, never>` -- a command may not ask for ANYTHING
  // from the context. `cli:help` still needed to know who is asking, to show each caller only the
  // commands they may run; unfiltered, the list is an inventory of capabilities handed to exactly
  // those who lack them. Both right on their own, impossible together.
  //
  // The way out: the user arrives as an ARGUMENT, not from the context. The kernel dispatcher
  // already has the caller's permissions -- it checks them before calling `run` -- so it passes
  // them on. `R` stays `never`, the contract stays tight, and the command stays a pure function.
  //
  // Rejected: widening `R` to `CurrentUser`. It would have worked for `cli:help`, but once the
  // contract is open, ANY command may ask for ANY service -- and commands are the one path between
  // cubes that has already leaked an executable capability once (see `manifest.ts`).
  //
  // The full reasoning lives next to the type, in `kernel/manifest.ts`, not here.
  create: ({ commands, runCommands: given }: CubeTools) => {
    const runCommands = requireTool(
      given,
      "cli asked for `runsCommands: true` but received no dispatcher -- kernel bug",
    )

    return {
      commands: [
        {
          name: "cli:help",
          summary: "list the commands you may run",
          permission: "cli:read",
          // Filtered by the CALLER's permissions, which arrive as an argument from the dispatcher.
          // The list once showed everything regardless of who asked -- a free inventory of
          // capabilities handed to exactly the caller who cannot use them.
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

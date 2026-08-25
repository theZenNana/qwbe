import { Effect } from "effect"
import type { CommandSpec, CubeTools } from "qwbe-core/cube"

type NoteSummary = Readonly<{ title: string; createdAt: string }>

export const notesCommands = (store: CubeTools["store"]): ReadonlyArray<CommandSpec> => [
  {
    name: "notes:count",
    summary: "how many notes exist",
    permission: "notes:read",
    run: () => Effect.map(store.count("notes"), (count) => String(count)),
  },
  {
    name: "notes:recent",
    summary: "the newest notes -- `notes:recent [howMany]`",
    permission: "notes:read",
    maxArgs: 1,
    run: (args) =>
      Effect.gen(function* () {
        const howMany = Math.min(20, Math.max(1, Number(args[0] ?? 5) || 5))
        const page = yield* store.page<NoteSummary>("notes", {
          offset: 0,
          limit: howMany,
          sortBy: "createdAt",
          descending: true,
        })
        return (
          page.rows.map((note) => `${note.createdAt.slice(0, 16).replace("T", " ")}  ${note.title}`).join("\n") ||
          "(none)"
        )
      }),
  },
]

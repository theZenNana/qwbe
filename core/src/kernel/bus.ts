// The event bus — the legal path for "something happened".
//
// Without one, the first person who needs "when a note is created, do X" has no sanctioned
// route, so they write an import, and from there the whole rule goes. The lesson from the
// previous system, measured rather than assumed: what matters is not how many rules you write
// but how expensive it is to go around them. A rule with no legal alternative is not obeyed,
// it is bypassed.
//
// So: events by STRING name. The publisher does not know who listens; the listener does not
// import the publisher. A cube that is absent or switched off is simply not subscribed — the
// event publishes into nothing, which is the correct behaviour: "decoupled" means "not there",
// not "crashed".
//
// What this is not: not a queue, not durable, not ordered across processes. When it becomes
// real, this file changes — not the contract cubes see.

import { Effect } from "effect"
import type { CubeBus, Subscription } from "./manifest.ts"

export type JournalEntry = {
  readonly event: string
  readonly publishedBy: string
  readonly at: string
  readonly listeners: number
}

export const busFrom = (
  subscriptions: ReadonlyArray<{ readonly cube: string; readonly subscription: Subscription }>,
  isEnabled: (cube: string) => boolean,
) => {
  const journal: Array<JournalEntry> = []

  // The subscription list is filled while cubes are being created, so a cube that publishes
  // inside its own `create` would reach only the cubes mounted before it — silently, and in an
  // order that is just the alphabetical order of directory names. Rather than leave that as a
  // latent trap, publishing is refused until mounting is finished.
  let sealed = false

  const publishFrom = (publishedBy: string, declared?: ReadonlySet<string>) => (event: string, payload: unknown) =>
    Effect.gen(function* () {
      if (!sealed) {
        return yield* Effect.die(
          new Error(`Cube "${publishedBy}" published "${event}" during mount; publish only after mounting.`),
        )
      }
      // The `qwbe/` prefix is the kernel's own channel: a cube cannot impersonate a kernel
      // announcement (qwbe/cube.enabled), because a subscriber has no other way to know who
      // is speaking. The kernel publishes from the name "qwbe", which no cube can carry --
      // the name pattern forbids it.
      if (event.startsWith("qwbe/") && publishedBy !== "qwbe") {
        return yield* Effect.die(new Error(`Cube "${publishedBy}" cannot publish reserved event "${event}".`))
      }
      if (declared && !declared.has(event)) {
        return yield* Effect.die(
          new Error(`Cube "${publishedBy}" published undeclared event "${event}". Add it to manifest.publishes.`),
        )
      }
      const targets = subscriptions.filter((s) => s.subscription.event === event && isEnabled(s.cube))

      journal.push({ event, publishedBy, at: new Date().toISOString(), listeners: targets.length })
      if (journal.length > 200) journal.shift()

      // One bad listener must not kill delivery for the rest — and this used to be a comment
      // rather than a fact. The `Effect<void, never, never>` type forces a listener to declare
      // no failures, but a THROW is a defect, not a failure: it escaped the loop, stopped every
      // listener after it, and turned the publisher's request into a 500 — after its data had
      // already been written. A reviewer found the promise and the behaviour disagreeing.
      //
      // The isolation now lives here, where it can be relied upon, instead of in the type.
      for (const t of targets) {
        yield* t.subscription.handle(payload).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              console.warn(
                `bus: listener in cube "${t.cube}" failed on "${event}" — delivery continues.\n` +
                  `     ${String(cause).split("\n")[0]}`,
              )
            }),
          ),
        )
      }
    })

  return {
    /** The bus as given to one cube. The publisher name is closed over, so it cannot spoof another. */
    for: (cube: string, declared?: ReadonlyArray<string>): CubeBus => ({
      publish: publishFrom(cube, declared ? new Set(declared) : undefined),
    }),
    /** Called by the kernel once every cube has been created and every subscription registered. */
    seal: () => {
      sealed = true
    },
    journal: (): ReadonlyArray<JournalEntry> => [...journal].reverse(),
    map: (): ReadonlyArray<{ readonly event: string; readonly cube: string }> =>
      subscriptions.map((s) => ({ event: s.subscription.event, cube: s.cube })),
  }
}

export type Bus = ReturnType<typeof busFrom>

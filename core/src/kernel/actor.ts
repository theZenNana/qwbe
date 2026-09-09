// The request-scoped actor for activity capture. A FiberRef, not a Context.Tag: the store
// reads it INSIDE `Effect.promise` territory, where a service would demand an `R` the
// CubeStore contract (`R = never`) forbids -- a FiberRef read needs no requirement.
//
// NOT exported through `qwbe-core/*`: a cube cannot set it. The only writer is the kernel's
// handler wrapper (`withActor` in runtime-composition.ts), which copies it from the
// authenticated `CurrentUser`. Nothing here can be spoofed by a plugin; a write with no
// authenticated user records `null` (rendered as "system" by the feed later), never an
// invented identity.
import { FiberRef } from "effect"

export type ActivityActor = { readonly id: string; readonly username: string }

export const CurrentActor = FiberRef.unsafeMake<ActivityActor | undefined>(undefined)

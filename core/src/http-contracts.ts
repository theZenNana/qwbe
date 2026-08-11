// Public HTTP data contracts shared by endpoint declarations and clients.
// This module imports no cube or kernel implementation. Effect Schema is the single source for
// runtime decoding, TypeScript inference and generated OpenAPI.

import { Schema } from "effect"

export const Pair = Schema.Struct({ key: Schema.String, value: Schema.String }).annotations({ identifier: "Pair" })
export const Summary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  details: Schema.Array(Pair),
}).annotations({ identifier: "Summary" })

export const PageOf = <A, I, R>(row: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    rows: Schema.Array(row),
    total: Schema.Number,
    offset: Schema.Number,
    limit: Schema.Number,
    sortedBy: Schema.String,
  })
export type PageResponse<A> = {
  readonly rows: ReadonlyArray<A>
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly sortedBy: string
}

export const CubeInfo = Schema.Struct({
  name: Schema.String,
  parent: Schema.NullOr(Schema.String),
  prefix: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  required: Schema.Boolean,
  system: Schema.Boolean,
  plugin: Schema.NullOr(Schema.String),
  onDisk: Schema.Boolean,
  entity: Schema.NullOr(Schema.String),
  screen: Schema.Boolean,
  publishes: Schema.Array(Schema.String),
  links: Schema.Array(Schema.Struct({ to: Schema.String, field: Schema.String, label: Schema.String })),
}).annotations({ identifier: "CubeState" })

export const PackageInfo = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("cube", "plugin"),
  summary: Schema.String,
  cubes: Schema.Array(Schema.String),
  installed: Schema.Boolean,
  bytes: Schema.Number,
  conflicts: Schema.Array(Schema.String),
}).annotations({ identifier: "PackageState" })

export const InstallFromPayload = Schema.Struct({ path: Schema.String }).annotations({
  identifier: "InstallFromPayload",
})
export const InstallResult = Schema.Struct({ package: PackageInfo, requiresRestart: Schema.Boolean }).annotations({
  identifier: "InstallResult",
})
export const InstallFromResult = Schema.Struct({
  package: PackageInfo,
  staged: Schema.Boolean,
  requiresRestart: Schema.Boolean,
}).annotations({ identifier: "InstallFromResult" })
export const RemoveResult = Schema.Struct({ removed: Schema.String, requiresRestart: Schema.Boolean }).annotations({
  identifier: "RemoveResult",
})
export const RestartResult = Schema.Struct({ restarting: Schema.Boolean, message: Schema.String }).annotations({
  identifier: "RestartResult",
})

export const Credentials = Schema.Struct({ username: Schema.String, password: Schema.String }).annotations({
  identifier: "Credentials",
})
export const SessionToken = Schema.Struct({ token: Schema.String, expiresAt: Schema.String }).annotations({
  identifier: "SessionToken",
})
export const Me = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  roles: Schema.Array(Schema.String),
  permissions: Schema.Array(Schema.String),
}).annotations({ identifier: "Me" })
export const Ok = Schema.Struct({ ok: Schema.Boolean }).annotations({ identifier: "Ok" })

export const CommandInfo = Schema.Struct({
  name: Schema.String,
  summary: Schema.String,
  permission: Schema.String,
  allowed: Schema.Boolean,
}).annotations({ identifier: "CommandInfo" })
export const Invocation = Schema.Struct({ line: Schema.String }).annotations({ identifier: "Invocation" })
export const CommandResult = Schema.Struct({
  command: Schema.String,
  output: Schema.String,
  ok: Schema.Boolean,
}).annotations({ identifier: "Result" })

export const GroupHead = Schema.Struct({
  cube: Schema.String,
  label: Schema.String,
  field: Schema.String,
  total: Schema.Number,
}).annotations({ identifier: "GroupHead" })
export const ParentLink = Schema.Struct({
  field: Schema.String,
  to: Schema.String,
  summary: Schema.NullOr(Summary),
}).annotations({ identifier: "Parent" })
export const LinksFor = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  parents: Schema.Array(ParentLink),
  groups: Schema.Array(GroupHead),
}).annotations({ identifier: "Links" })

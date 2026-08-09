import { Schema } from "effect"
import { EntityMeta, type SummaryRow } from "../../kernel/entity.ts"

export const Account = Schema.Struct({
  ...EntityMeta,
  username: Schema.String,
  displayName: Schema.String,
  email: Schema.String,
  roles: Schema.Array(Schema.String),
}).annotations({ identifier: "Account" })

export type AccountRow = typeof Account.Type & { passwordHash: string }

export const publicShape = (a: AccountRow) => ({
  id: a.id,
  type: a.type,
  createdAt: a.createdAt,
  deleted: a.deleted,
  username: a.username,
  displayName: a.displayName,
  email: a.email,
  roles: a.roles,
})

export const summary = (a: AccountRow): SummaryRow => ({
  id: a.id,
  title: a.username,
  details: [
    { key: "displayName", value: a.displayName },
    { key: "email", value: a.email },
    { key: "roles", value: (a.roles ?? []).join(",") },
  ],
})

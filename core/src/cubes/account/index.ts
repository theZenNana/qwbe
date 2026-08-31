// User accounts and credential verification. Password hashes never cross this cube boundary.

import { createHash, randomBytes } from "node:crypto"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Authorization, requirePermission } from "../../kernel/auth-contract.ts"
import { Forbidden, NotFound } from "../../kernel/errors.ts"
import { genericList, ListParams } from "../../kernel/list.ts"
import { PageOf } from "../../kernel/pagination.ts"
import { identityDirectory } from "./identity.ts"
import { Account, type AccountRow, publicShape, summary } from "./model.ts"
import { constantTimeEquals, hashPassword, verifyPassword } from "./password.ts"

const TABLE = "accounts"
const ENTITY = "Account"

/** Read-only compatibility for existing prototype databases; successful login upgrades it. */
const legacyHash = (password: string) => createHash("sha256").update(`cubes-prototype-salt:${password}`).digest("hex")

const AccountCreate = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
  displayName: Schema.optionalWith(Schema.String, { default: () => "" }),
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
  roles: Schema.optionalWith(Schema.Array(Schema.String), { default: () => ["reader"] }),
}).annotations({ identifier: "AccountCreate" })

const group = HttpApiGroup.make("account")
  .add(HttpApiEndpoint.get("list")`/account`.setUrlParams(ListParams).addSuccess(PageOf(Account)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/account/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Account)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/account`.setPayload(AccountCreate).addSuccess(Account).addError(Forbidden))
  .middleware(Authorization)

// Named, because the generic list handler reads its `searchable` and `relations` to build the
// query it serves (QWB-54): the manifest is the contract, so the handler must see it.
const manifest = {
  name: "account",
  // Opts the cube into the metadata drift gate (see src/metadata/schema-drift.ts). 1.1.0 is
  // the bump the gate asked for when `searchable` below made three fields filterable.
  version: "1.1.0",
  tables: [TABLE],
  entity: ENTITY,
  // Deliberately NOT `passwordHash`. Ordering by it returned 200 to an ordinary reader and
  // leaked information about a value that never appears in any response.
  sortable: ["username", "displayName", "email"],
  // QWB-54: the same three fields answer `?q=` and `?username=` on the list. Same reasoning as
  // `sortable` -- a hash is never among them. Declaring this changed the published field
  // metadata, which is why `version` went to 1.1.0 above.
  searchable: ["username", "displayName", "email"],
  requiresAuth: true,
  required: true,
  // This cube stores credentials, so it is the one that checks them. Declared here, in the
  // open: `grep -r providesCredentials src/cubes/ plugins/` shows every cube that can.
  providesCredentials: true,
  providesIdentityDirectory: true,
  permissions: [
    { name: "account:read", roles: ["admin", "reader"] },
    { name: "account:write", roles: ["admin"] },
  ],
  publishes: ["account.created"],
} as const

export const cube = defineCube(group, {
  manifest,

  create: ({ store, bus }: CubeTools) => {
    /** Seed once. A generated bootstrap password is printed once when no external secret exists. */
    const seed = Effect.gen(function* () {
      if ((yield* store.count(TABLE)) > 0) return
      const adminPassword = process.env.QWBE_ADMIN_PASSWORD || randomBytes(24).toString("base64url")
      yield* store.insert(TABLE, ENTITY, "acc", {
        username: "admin",
        passwordHash: hashPassword(adminPassword),
        displayName: "Administrator",
        email: "",
        roles: ["admin"],
      })
      if (!process.env.QWBE_ADMIN_PASSWORD) {
        console.error(`[qwbe bootstrap] admin password (shown once): ${adminPassword}`)
      }
      const readerPassword = process.env.QWBE_READER_PASSWORD
      if (readerPassword) {
        yield* store.insert(TABLE, ENTITY, "acc", {
          username: "reader",
          passwordHash: hashPassword(readerPassword),
          displayName: "Read Only",
          email: "",
          roles: ["reader"],
        })
      }
    })

    return {
      identities: identityDirectory(store, seed),
      /** Unknown users still pay one KDF, limiting username timing disclosure. */
      credentials: {
        verify: (username: string, password: string) =>
          Effect.gen(function* () {
            yield* seed
            const rows = yield* store.all<AccountRow>(TABLE)
            const found = rows.find((a) => a.username === username)
            const expected = found?.passwordHash ?? hashPassword(randomBytes(24).toString("base64url"))
            const legacy = /^[a-f0-9]{64}$/.test(expected)
            const matches = legacy
              ? constantTimeEquals(legacyHash(password), expected)
              : verifyPassword(password, expected)
            if (!found || !matches) return undefined
            if (legacy) yield* store.update(TABLE, found.id, { passwordHash: hashPassword(password) })
            return { id: found.id, username: found.username, roles: found.roles ?? [] }
          }),
      },

      commands: [
        {
          name: "account:list",
          summary: "list usernames and their roles",
          permission: "account:read",
          run: () =>
            Effect.gen(function* () {
              yield* seed
              const rows = yield* store.all<AccountRow>(TABLE)
              return rows.map((a) => `${a.username}\t${(a.roles ?? []).join(",")}`).join("\n") || "(none)"
            }),
        },
        {
          name: "account:count",
          summary: "how many accounts exist",
          permission: "account:read",
          run: () => Effect.map(store.count(TABLE), (n) => String(n)),
        },
      ],

      handlers: {
        // The kernel's list, not this cube's (QWB-54). Every parameter in the contract works
        // here because none of them is implemented here.
        list: genericList<AccountRow, ReturnType<typeof publicShape>>({
          cube: "account",
          table: TABLE,
          manifest,
          store,
          map: publicShape,
          // `auth` looks a user up through the registry before any HTTP handler has necessarily
          // run, so the very first list must still find the seeded admin.
          before: seed,
        }),

        get: ({ path }: { path: { id: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("account:read")
            const a = yield* store.byId<AccountRow>(TABLE, path.id)
            if (!a) return yield* Effect.fail(new NotFound({ message: `account ${path.id} does not exist` }))
            return publicShape(a)
          }),

        create: ({ payload }: { payload: typeof AccountCreate.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("account:write")
            const { password, ...rest } = payload
            const a = (yield* store.insert(TABLE, ENTITY, "acc", {
              ...rest,
              passwordHash: hashPassword(password),
            })) as AccountRow
            yield* bus.publish("account.created", { id: a.id, title: a.username })
            return publicShape(a)
          }),
      },

      relational: {
        // Seeding runs here too: `auth` looks a user up through the registry before any HTTP
        // handler has necessarily run, so the very first login must find the seeded admin.
        search: (field, value, page) =>
          Effect.gen(function* () {
            yield* seed
            const p = yield* store.page<AccountRow>(TABLE, page, { field, value })
            return { rows: p.rows.map(summary), total: p.total }
          }),

        summaryById: (id) =>
          Effect.gen(function* () {
            const a = yield* store.byId<AccountRow>(TABLE, id)
            return a ? summary(a) : undefined
          }),

        fieldValue: (id, field) =>
          Effect.gen(function* () {
            const a = yield* store.byId<AccountRow>(TABLE, id)
            const v = a ? (a as unknown as Record<string, unknown>)[field] : null
            return typeof v === "string" ? v : null
          }),
      },
    }
  },
})

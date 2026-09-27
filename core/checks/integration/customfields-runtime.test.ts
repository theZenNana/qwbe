import assert from "node:assert/strict"
import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import { layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import { call } from "../../src/api-client.ts"
import { boot } from "../_layers/boot.ts"
import { copyPack } from "../_layers/pack-copy.ts"
import { connect, query } from "../_layers/postgres.ts"
import { type Session, sessionAs } from "../_layers/session.ts"
import { testWorkspace } from "../_layers/test-server.ts"
import { CORE, Workspace } from "../_layers/workspace.ts"

// Runtime evidence for QWB-54 ticket 05: the custom-field correctness defects, answered over
// HTTP by two server instances on ONE throwaway database. Two instances is the point of
// defect 4: server B boots before any definition exists, so the old per-process snapshot would
// leave it validating on empty forever. The target cube is the vault fixture, whose roles are
// skewed so no token holds vault:read: that is what makes the permission gates of defects 3 and 6
// observable (an admin keeps customfields:write, a reader keeps customfields:read, and both must
// still be refused). The workspace plugins directory holds ONLY the vault fixture, so no other
// pack's pre-ledger dataMigration can refuse the boot.

const VAULT = join(CORE, "checks", "_fixtures", "vault-pack")

/** Server A (admin session) and server B (reader session), both booted before any definition. */
class Servers extends Context.Tag("Servers")<
  Servers,
  { readonly a: string; readonly b: string; readonly admin: Session; readonly reader: Session }
>() {}

const servers = Effect.gen(function* () {
  const { pluginsDir } = yield* Workspace
  yield* copyPack(VAULT)(pluginsDir)
  // Same database, own data directory each: B must know the definitions through nothing but the
  // shared database.
  const dataB = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectoryScoped({ prefix: "qwbe-check-data-b-" }),
  )
  const [a, b] = yield* Effect.all([boot(), boot({ QWBE_DATA_DIR: dataB })], { concurrency: "unbounded" })
  return { a, b, admin: yield* sessionAs(a, "admin"), reader: yield* sessionAs(b, "reader") }
})

const ServersLive = Layer.scoped(Servers, servers).pipe(Layer.provideMerge(testWorkspace("customfields_runtime")))

/** A body field as text, the way the defects are asserted; absent reads "undefined". */
const fieldOf = (body: unknown, key: string) => String(Predicate.hasProperty(body, key) ? body[key] : undefined)

const define = (body: Record<string, unknown>) =>
  Effect.flatMap(Servers, ({ admin }) => admin.send("POST", "/customfields", body))

/** SQL as the database owner on the shared database, for the fault injection of defect 4. */
const asOwner = (text: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect((yield* Workspace).url)
      yield* query(client, text)
    }),
  )

layer(ServersLive, { timeout: 120_000, excludeTestServices: true })(
  "custom-field correctness over HTTP (QWB-54 ticket 05)",
  (it) => {
    let rowId = ""

    it.effect("defect 1: a POST without a required custom field is a 400, with it a 200", () =>
      Effect.gen(function* () {
        const { admin } = yield* Servers
        const defined = yield* define({ targetCube: "vault", name: "seal", fieldType: "text", required: true })
        assert.equal(defined.status, 200)
        const without = yield* admin.send("POST", "/vault", { name: "missing" })
        assert.equal(without.status, 400)
        assert.match(fieldOf(without.body, "message"), /seal/)
        const with_ = yield* admin.send("POST", "/vault", { name: "present", seal: "gold" })
        assert.equal(with_.status, 200)
        rowId = fieldOf(with_.body, "id")
      }),
    )

    it.effect("defect 3: orphans refuse customfields:write without vault:read", () =>
      Effect.gen(function* () {
        // Admin holds customfields:write; nobody holds vault:read. Without the new gate this
        // answers 200 and reads another cube's rows.
        const { admin } = yield* Servers
        assert.equal(yield* admin.status("/customfields/orphans?cube=vault"), 403)
      }),
    )

    it.effect("defect 6: setValues refuses customfields:read without vault:read", () =>
      Effect.gen(function* () {
        // The reader passes the old first gate; without the new one it would read the target
        // row's custom values back.
        const { reader } = yield* Servers
        const r = yield* reader.send("PUT", "/customfields/values", { cube: "vault", rowId, values: {} })
        assert.equal(r.status, 403)
      }),
    )

    it.effect("defect 2: one-key PATCHes stop at the cap -- the patch that would make 33 keys is a 400", () =>
      Effect.gen(function* () {
        const { admin } = yield* Servers
        for (let i = 1; i <= 32; i++) {
          const d = yield* define({ targetCube: "vault", name: `seal${i}`, fieldType: "text" })
          assert.equal(d.status, 200)
        }
        const patched: Array<number> = []
        let refused: { status: number; body: unknown } = { status: 0, body: {} }
        // The row carries the required `seal` already, so the cap is reached one PATCH earlier
        // than the ticket's from-empty arithmetic: 31 patches land on exactly 32 keys, the 32nd
        // would make 33.
        for (let i = 1; i <= 32; i++) {
          const r = yield* admin.send("PATCH", `/vault/${rowId}`, { [`seal${i}`]: "x" })
          patched.push(r.status)
          if (i < 32) assert.equal(r.status, 200, `patch ${i} should have merged fine: ${JSON.stringify(r.body)}`)
          else refused = r
        }
        assert.deepEqual(patched[31], 400)
        assert.match(fieldOf(refused.body, "message"), /cap/)
      }),
    )

    it.effect("defect 4: a definition created through A validates a POST through B", () =>
      Effect.gen(function* () {
        const { b, admin } = yield* Servers
        const defined = yield* define({ targetCube: "vault", name: "age", fieldType: "number" })
        assert.equal(defined.status, 200)
        // The admin's token from A, sent to B: sessions live in the shared database too.
        const throughB = (body: unknown) => call(b, "/vault", { method: "POST", token: admin.token, body })
        const invalid = yield* throughB({ name: "via-b", seal: "s", age: "abc" })
        assert.equal(invalid.status, 400)
        assert.match(fieldOf(invalid.body, "message"), /age/)
        const valid = yield* throughB({ name: "via-b2", seal: "s", age: "41" })
        assert.equal(valid.status, 200)
      }),
    )

    it.effect("defect 4: a definitions read that fails is a 500, never validate-on-empty", () =>
      Effect.gen(function* () {
        const { admin } = yield* Servers
        yield* asOwner(`REVOKE USAGE ON SCHEMA "customfields" FROM qwbe_cube_customfields`)
        const broken = yield* admin.send("POST", "/vault", { name: "broken", seal: "s" })
        assert.equal(broken.status, 500)
        yield* asOwner(`GRANT USAGE ON SCHEMA "customfields" TO qwbe_cube_customfields`)
        const recovered = yield* admin.send("POST", "/vault", { name: "recovered", seal: "s" })
        assert.equal(recovered.status, 200)
      }),
    )
  },
)

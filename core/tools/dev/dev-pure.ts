// Decisions of the dev supervisor; dev.ts and dev-ports.ts do the I/O.
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { Port } from "../shared/config.ts"
import type { Argv } from "../shared/process.ts"
import { withoutAllowScripts } from "../shared/process-pure.ts"

// The API restarts on exit 0 (the admin restart). More than five clean exits in a row, each under
// 10 s, is a loop, not a restart.
const QUICK_EXIT_MS = 10_000
const MAX_QUICK_EXITS = 5

type Env = Readonly<Record<string, string | undefined>>
export type ServiceName = "api" | "web"
export type Ports = Readonly<Record<ServiceName, number>>

export type ServiceSpec = {
  readonly argv: Argv
  readonly cwd: string
  readonly env: Env
  readonly shell: boolean
  readonly restartOnClean: boolean
  readonly color: number
}

export type AfterExit =
  | { readonly _tag: "restart"; readonly quickExits: number; readonly delayMillis: number; readonly message: string }
  | { readonly _tag: "stop"; readonly status: number; readonly message: string }

export const SERVICES = { start: ["api", "web"], api: ["api"], web: ["web"] } as const

const PortText = Schema.compose(Schema.NumberFromString, Port)

const portFrom = (name: string, configured: number, override: string | undefined) =>
  override === undefined
    ? Either.right(configured)
    : Either.mapLeft(Schema.decodeUnknownEither(PortText)(override), () => ({
        file: name,
        message: `${name}=${override}: not a port (1-65535)`,
      }))

// qwbe.yaml decides; QWBE_PORT / QWBE_WEB_PORT move one port for a single run.
export const devPorts = (
  api: number,
  web: number,
  apiOverride: string | undefined,
  webOverride: string | undefined,
): Either.Either<Ports, { readonly file: string; readonly message: string }> =>
  Either.all({ api: portFrom("QWBE_PORT", api, apiOverride), web: portFrom("QWBE_WEB_PORT", web, webOverride) })

// The frontend knows the API only by its address; a moved API port has to reach it.
export const serviceSpecs = (
  root: string,
  ports: Ports,
  env: Env,
  node: string,
  windows: boolean,
): Readonly<Record<ServiceName, ServiceSpec>> => {
  const childEnv = withoutAllowScripts(env)
  return {
    api: {
      argv: [node, "src/main.ts"],
      cwd: `${root}core`,
      env: { ...childEnv, QWBE_PORT: String(ports.api) },
      shell: false,
      restartOnClean: true,
      color: 36,
    },
    web: {
      argv: ["npm", "run", "dev", "--", "-p", String(ports.web)],
      cwd: `${root}web`,
      env: { ...childEnv, NEXT_PUBLIC_QWBE_API: env.NEXT_PUBLIC_QWBE_API ?? `http://127.0.0.1:${ports.api}` },
      shell: windows,
      restartOnClean: false,
      color: 35,
    },
  }
}

const exitedMessage = (code: number) => `exited (code ${code}), stopping the rest`

// What the supervisor does after a child exits with `code` after `ranMillis`, given the quick
// exits before it. A clean exit that ends the restart loop is still a failure of the run.
export const afterExit = (restartOnClean: boolean, code: number, ranMillis: number, quickExits: number): AfterExit => {
  if (!restartOnClean || code !== 0) return { _tag: "stop", status: code, message: exitedMessage(code) }
  const quick = ranMillis < QUICK_EXIT_MS ? quickExits + 1 : 1
  if (quick > MAX_QUICK_EXITS) {
    return { _tag: "stop", status: 1, message: `exited cleanly ${quick} times in under 10s, stopping the restart loop` }
  }
  const delayMillis = Math.min(250 * 2 ** (quick - 1), 4000)
  return { _tag: "restart", quickExits: quick, delayMillis, message: `exited (code 0); restarting in ${delayMillis}ms` }
}

export const banner = (names: ReadonlyArray<ServiceName>, ports: Ports) =>
  `${names.map((name) => `${name} on http://127.0.0.1:${ports[name]}`).join(", ")}\n` +
  "Sign in as admin: password from QWBE_ADMIN_PASSWORD, or printed once at first seed. Ctrl-C stops everything.\n"

// `[name] line`, the tag colored only on a terminal.
export const prefixer = (name: string, color: number, tty: boolean) => {
  const tag = tty ? `\x1b[${color}m[${name}]\x1b[0m` : `[${name}]`
  return (line: string) => `${tag} ${line}`
}

export const portTakenMessage = (name: string, port: number) =>
  `Port ${port} (${name}) is already taken, nothing was started. ` +
  `See who has it: ss -ltnp | grep ${port}. Or move it for one run: QWBE_PORT / QWBE_WEB_PORT, or qwbe.yaml.`

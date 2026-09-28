import { expect, it } from "@effect/vitest"
import * as Either from "effect/Either"
import { afterExit, banner, devArgs, devPorts, heapMessage, prefixer, SERVICES, serviceSpecs } from "./dev-pure.ts"

const plain = { profile: false, cpuProf: false }

it("start runs both services, api and web one each", () => {
  expect(SERVICES).toEqual({ start: ["api", "web"], api: ["api"], web: ["web"] })
})

it("counts quick exits in a row and resets after a long run", () => {
  expect(afterExit(true, 0, 500, 2)).toMatchObject({ _tag: "restart", quickExits: 3 })
  expect(afterExit(true, 0, 10_000, 4)).toMatchObject({ _tag: "restart", quickExits: 1 })
})

it("restarts only on exit 0 and at most five quick times in a row", () => {
  expect(afterExit(true, 0, 500, 4)._tag).toBe("restart")
  expect(afterExit(true, 0, 500, 5)._tag).toBe("stop")
  expect(afterExit(true, 1, 500, 0)._tag).toBe("stop")
})

it("backs off from 250ms, doubling, up to 4s", () => {
  const delays = [0, 1, 2, 4].map((before) => afterExit(true, 0, 500, before))
  expect(delays.map((next) => (next._tag === "restart" ? next.delayMillis : 0))).toEqual([250, 500, 1000, 4000])
  expect(delays[0]?.message).toBe("exited (code 0); restarting in 250ms")
})

it("a stopped restart loop is exit 1; any other exit keeps its code", () => {
  expect(afterExit(true, 0, 500, 5)).toEqual({
    _tag: "stop",
    status: 1,
    message: "exited cleanly 6 times in under 10s, stopping the restart loop",
  })
  expect(afterExit(true, 3, 500, 0)).toEqual({ _tag: "stop", status: 3, message: "exited (code 3), stopping the rest" })
})

it("a service without restart stops on any exit, a clean one included", () => {
  expect(afterExit(false, 0, 500, 0)).toEqual({
    _tag: "stop",
    status: 0,
    message: "exited (code 0), stopping the rest",
  })
})

it("an env override moves one port; a bad one names its variable", () => {
  expect(devPorts(4500, 4510, "4530", undefined)).toEqual(Either.right({ api: 4530, web: 4510 }))
  expect(devPorts(4500, 4510, undefined, "70000")).toEqual(
    Either.left({ file: "QWBE_WEB_PORT", message: "QWBE_WEB_PORT=70000: not a port (1-65535)" }),
  )
})

it("web reaches a moved API port unless NEXT_PUBLIC_QWBE_API names one", () => {
  const ports = { api: 4530, web: 4510 }
  expect(serviceSpecs("/r/", ports, {}, "node", false, plain).web.env.NEXT_PUBLIC_QWBE_API).toBe(
    "http://127.0.0.1:4530",
  )
  expect(
    serviceSpecs("/r/", ports, { NEXT_PUBLIC_QWBE_API: "http://x" }, "node", false, plain).web.env.NEXT_PUBLIC_QWBE_API,
  ).toBe("http://x")
})

it("prefixes each line, colored only on a terminal", () => {
  expect(prefixer("api", 36, false)("up")).toBe("[api] up")
  expect(prefixer("web", 35, true)("up")).toBe("\x1b[35m[web]\x1b[0m up")
})

it("the banner names each started service with its address", () => {
  expect(banner(["api", "web"], { api: 4500, web: 4510 })).toMatch(
    /^api on http:\/\/127\.0\.0\.1:4500, web on http:\/\/127\.0\.0\.1:4510\n/,
  )
})

it("parses at most one subcommand and the flags in any order", () => {
  expect(devArgs([])).toEqual(Either.right({ name: "start", profile: false, cpuProf: false }))
  expect(devArgs(["--profile"])).toEqual(Either.right({ name: "start", profile: true, cpuProf: false }))
  expect(devArgs(["--cpu-prof", "api"])).toEqual(Either.right({ name: "api", profile: false, cpuProf: true }))
  expect(devArgs(["api", "--profile", "--cpu-prof"])).toEqual(
    Either.right({ name: "api", profile: true, cpuProf: true }),
  )
  expect(Either.isLeft(devArgs(["api", "web"]))).toBe(true)
  expect(Either.isLeft(devArgs(["--heap"]))).toBe(true)
})

const api = (flags: { profile: boolean; cpuProf: boolean }, env: Record<string, string> = {}) =>
  serviceSpecs("/r/", { api: 4500, web: 4510 }, env, "node", false, flags).api

it("the API always takes a heap snapshot on SIGUSR2 and traces nowhere without a flag", () => {
  expect(api(plain).argv).toEqual([
    "node",
    "--heapsnapshot-signal=SIGUSR2",
    "--diagnostic-dir=/r/.profile/heap",
    "src/main.ts",
  ])
  expect(api(plain).env.QWBE_TRACE_URL).toBeUndefined()
  expect(heapMessage(api(plain).heapDir ?? "", 42)).toBe("pid 42; heap snapshot: kill -USR2 42 (into /r/.profile/heap)")
})

it("--cpu-prof adds the V8 CPU profile into .profile/cpu", () => {
  expect(api({ profile: false, cpuProf: true }).argv.slice(3, 5)).toEqual([
    "--cpu-prof",
    "--cpu-prof-dir=/r/.profile/cpu",
  ])
})

it("--profile traces the API into the local lgtm with every category", () => {
  const spec = api({ profile: true, cpuProf: false })
  expect(spec.env).toMatchObject({
    QWBE_TRACE_URL: "http://127.0.0.1:4318",
    QWBE_PROFILE: "requests,resources,process",
  })
  expect(spec.argv).not.toContain("--cpu-prof")
})

it("both flags together, and a QWBE_PROFILE already set wins", () => {
  const spec = api({ profile: true, cpuProf: true }, { QWBE_PROFILE: "requests" })
  expect(spec.env.QWBE_PROFILE).toBe("requests")
  expect(spec.argv).toContain("--cpu-prof")
  expect(
    serviceSpecs("/r/", { api: 4500, web: 4510 }, {}, "node", false, { profile: true, cpuProf: true }).web.env
      .QWBE_TRACE_URL,
  ).toBeUndefined()
})

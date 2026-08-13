"use client"

// THE GENERIC AGENT route -- one screen for every cube whose manifest declares `agent: true`,
// including plugins nobody has written yet. Everything drawn here comes from the shared
// contract (`qwbe-core/agent` via lib/contracts.ts) and the catalogue: nothing on this page
// knows which runtime sits behind the cube.
//
// The three states are the contract's own: `ready` (health answered), `unavailable`
// (the surface answered 503 -- not configured, not started) and `error` (the surface did
// not answer its own contract at all).

import { use, useEffect, useState } from "react"
import {
  type AgentContext,
  type AgentHealth,
  type AgentTrace,
  ApiError,
  agentApiPrefix,
  agentContext,
  agentHealth,
  agentTrace,
  catalogue,
  runAgentGoal,
} from "../../../lib/api"
import { Shell } from "../../Shell"

type AgentState =
  | { readonly kind: "checking" }
  | { readonly kind: "ready"; readonly health: AgentHealth; readonly context: AgentContext | null }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }

export default function CubeAgent({ params }: { params: Promise<{ cube: ReadonlyArray<string> }> }) {
  const { cube: segments } = use(params)
  const cube = segments.join("/")
  const [state, setState] = useState<AgentState>({ kind: "checking" })
  const [prefix, setPrefix] = useState<string | null>(null)
  const [trace, setTrace] = useState<AgentTrace | null>(null)
  const [goal, setGoal] = useState("")
  const [result, setResult] = useState("")
  const [model, setModel] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    catalogue()
      .then(async (cubes) => {
        const selected = cubes.find((candidate) => candidate.name === cube && candidate.agent)
        if (!selected) throw new Error(`agent cube not found: ${cube}`)
        const mountedPrefix = agentApiPrefix(selected)
        setPrefix(mountedPrefix)
        const health = await agentHealth(mountedPrefix)
        // Context and trace matter only once the runtime is alive; asking a down surface
        // for them would bury the real state under two more failures.
        const context = await agentContext(mountedPrefix).catch(() => null)
        setState({ kind: "ready", health, context })
        setTrace(await agentTrace(mountedPrefix).catch(() => null))
      })
      .catch((failure: Error) =>
        setState(
          failure instanceof ApiError && failure.status === 503
            ? { kind: "unavailable", message: failure.message }
            : { kind: "error", message: failure.message },
        ),
      )
  }, [cube])

  return (
    <Shell>
      <h2>Agent for {cube}</h2>
      <p className="subtitlu">This cube exposes an external runtime through the generic agent surface.</p>
      <div className="panou">
        <h3>Status</h3>
        {state.kind === "checking" && <div>checking</div>}
        {state.kind === "ready" && (
          <>
            <div>
              <span className="pastila viu">ready</span> - {state.health.runtime}
            </div>
            <div className="mic">
              scope: {state.context?.cube ?? cube}; cross-cube: {String(state.context?.crossCube ?? false)}
            </div>
          </>
        )}
        {state.kind === "unavailable" && (
          <div>
            <span className="pastila stins">unavailable</span> <span className="mic">{state.message}</span>
          </div>
        )}
        {state.kind === "error" && <div className="eroare">{state.message}</div>}
      </div>
      {error && <div className="eroare">{error}</div>}
      <form
        className="panou"
        onSubmit={(event) => {
          event.preventDefault()
          setError("")
          if (prefix === null) return
          runAgentGoal(prefix, goal)
            .then(async (next) => {
              setResult(next.answer)
              setModel(
                next.model
                  ? `${next.model}; ${next.usage?.promptTokens ?? 0} + ${next.usage?.completionTokens ?? 0} tokens`
                  : "",
              )
              setTrace(await agentTrace(prefix).catch(() => null))
            })
            .catch((failure: Error) => setError(failure.message))
        }}
      >
        <h3>Ask cube agent</h3>
        <input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          aria-label="Agent goal"
          required
          disabled={state.kind !== "ready"}
        />
        <button type="submit" disabled={state.kind !== "ready"}>
          Run
        </button>
        {result && <p>{result}</p>}
        {model && <p className="mic">{model}</p>}
      </form>
      <div className="panou">
        <h3>Trace</h3>
        <div className="mic">{trace?.events.map((event) => event.type).join(" / ") || "no events"}</div>
      </div>
    </Shell>
  )
}

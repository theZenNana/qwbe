"use client"

import { use, useEffect, useState } from "react"
import {
  type AgentContext,
  type AgentHealth,
  type AgentTrace,
  agentContext,
  agentHealth,
  agentTrace,
  runAgentGoal,
} from "../../../lib/api"
import { Shell } from "../../Shell"

export default function CubeAgent({ params }: { params: Promise<{ cube: string }> }) {
  const { cube } = use(params)
  const [health, setHealth] = useState<AgentHealth | null>(null)
  const [context, setContext] = useState<AgentContext | null>(null)
  const [trace, setTrace] = useState<AgentTrace | null>(null)
  const [goal, setGoal] = useState("")
  const [result, setResult] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    Promise.all([agentHealth(cube), agentContext(cube), agentTrace(cube)])
      .then(([nextHealth, nextContext, nextTrace]) => {
        setHealth(nextHealth)
        setContext(nextContext)
        setTrace(nextTrace)
        setError("")
      })
      .catch((failure: Error) => setError(failure.message))
  }, [cube])

  return (
    <Shell>
      <h2>Agent for {cube}</h2>
      <p className="subtitlu">Isolated ActiveGraph runtime. No LLM and no cross-cube context.</p>
      {error && <div className="eroare">{error}</div>}
      <div className="panou">
        <h3>Status</h3>
        <div>{health ? `${health.state} - ActiveGraph ${health.activegraph}` : "checking"}</div>
        <div className="mic">
          scope: {context?.cube ?? cube}; cross-cube: {String(context?.crossCube ?? false)}
        </div>
      </div>
      <form
        className="panou"
        onSubmit={(event) => {
          event.preventDefault()
          setError("")
          runAgentGoal(cube, goal)
            .then(async (next) => {
              setResult(next.object.text)
              setTrace(await agentTrace(cube))
            })
            .catch((failure: Error) => setError(failure.message))
        }}
      >
        <h3>Deterministic goal</h3>
        <input value={goal} onChange={(event) => setGoal(event.target.value)} aria-label="Agent goal" required />
        <button type="submit">Run</button>
        {result && <p>Captured: {result}</p>}
      </form>
      <div className="panou">
        <h3>Trace</h3>
        <div className="mic">{trace?.events.map((event) => event.type).join(" / ") || "no events"}</div>
      </div>
    </Shell>
  )
}

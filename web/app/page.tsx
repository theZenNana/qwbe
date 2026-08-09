"use client"

import { useEffect, useState } from "react"
import { type CubeInfo, catalogue, login } from "../lib/api"
import { session } from "../lib/session"
import { Shell } from "./Shell"

export default function Home() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [cubes, setCubes] = useState<Array<CubeInfo>>([])

  useEffect(() => {
    setSignedIn(!!session.read())
  }, [])

  useEffect(() => {
    if (signedIn)
      catalogue()
        .then(setCubes)
        .catch(() => setCubes([]))
  }, [signedIn])

  if (signedIn === null) return <div className="continut">…</div>

  if (!signedIn) {
    return (
      <div className="continut" style={{ maxWidth: 380, margin: "12vh auto" }}>
        <h2>Qwbe</h2>
        <p className="subtitlu">Sign in with an account created for this installation.</p>
        <form
          className="panou"
          onSubmit={async (e) => {
            e.preventDefault()
            setError(null)
            try {
              await login(username, password)
              setSignedIn(true)
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
            />
            <button type="submit">sign in</button>
          </div>
        </form>
        {error && <div className="eroare">{error}</div>}
      </div>
    )
  }

  const fromPlugins = cubes.filter((c) => c.plugin)

  return (
    <Shell>
      <h2>What is mounted</h2>
      <p className="subtitlu">
        This table comes from <code>GET /settings/cubes</code> — the manifests found on disk. No cube name is written
        anywhere in this frontend.
      </p>

      <div className="panou">
        <h3>Cubes ({cubes.length})</h3>
        <table>
          <thead>
            <tr>
              <th>cube</th>
              <th>source</th>
              <th>entity</th>
              <th>state</th>
              <th>links out</th>
              <th>publishes</th>
            </tr>
          </thead>
          <tbody>
            {cubes.map((c) => (
              <tr key={c.name}>
                <td>{c.entity ? <a href={`/${c.name}`}>{c.name}</a> : c.name}</td>
                <td className="mic">{c.plugin ? `plugin: ${c.plugin}` : "core"}</td>
                <td>{c.entity ?? <span className="mic">—</span>}</td>
                <td>
                  <span className={`pastila ${c.enabled ? "viu" : "stins"}`}>{c.enabled ? "on" : "off"}</span>
                  {c.required && <span className="mic"> required</span>}
                </td>
                <td className="mic">
                  {c.links.length === 0 ? "—" : c.links.map((l) => `${l.field} → ${l.to} (“${l.label}”)`).join(", ")}
                </td>
                <td className="mic">{c.publishes.length === 0 ? "—" : c.publishes.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mic">
        {fromPlugins.length} cube(s) arrived in a plugin and sit in the same flat namespace as the rest. Links come from
        the spaces — declared by neither side.
      </p>
    </Shell>
  )
}

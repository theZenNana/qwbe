"use client"

// SETTINGS — switch cubes on and off.
//
// Not a screen written for the settings cube; a screen written for the CATALOGUE. A new cube on
// disk gets a row here. Required cubes have their button disabled, and the backend refuses the
// change as well — the rule sits in two places on purpose. If it lived only in the UI, a curl
// would walk around it.

import { useCallback, useEffect, useState } from "react"
import { type CubeInfo, catalogue, toggleCube } from "../../lib/api"
import { Shell } from "../Shell"

export default function Settings() {
  const [cubes, setCubes] = useState<Array<CubeInfo>>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // `useCallback`, nu o funcție obișnuită: fără el `reload` e alta la fiecare randare, deci
  // efectul care depinde de ea ar rula la nesfârșit. Așa are identitate stabilă și dependența
  // pe care o cere regula de lint devine adevărată, nu doar scrisă.
  const reload = useCallback(
    () =>
      catalogue()
        .then(setCubes)
        .catch((e: Error) => setError(e.message)),
    [],
  )
  useEffect(() => {
    reload()
  }, [reload])

  return (
    <Shell>
      <h2>Settings</h2>
      <p className="subtitlu">
        Switch a cube off and its routes return 404, its commands leave the terminal, and its related lists disappear
        from other cubes' pages — no restart.
      </p>

      {error && <div className="eroare">{error}</div>}

      <div className="panou">
        <table>
          <thead>
            <tr>
              <th>cube</th>
              <th>source</th>
              <th>entity</th>
              <th>state</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cubes.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="mic">{c.plugin ? `plugin: ${c.plugin}` : "core"}</td>
                <td className="mic">{c.entity ?? "—"}</td>
                <td>
                  <span className={`pastila ${c.enabled ? "viu" : "stins"}`}>{c.enabled ? "on" : "off"}</span>
                </td>
                <td>
                  <button
                    type="button"
                    disabled={c.required || busy === c.name}
                    title={c.required ? "required — cannot be switched off" : ""}
                    onClick={async () => {
                      setBusy(c.name)
                      setError(null)
                      try {
                        await toggleCube(c.name, !c.enabled)
                        await reload()
                      } catch (e) {
                        setError((e as Error).message)
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    {c.required ? "required" : c.enabled ? "switch off" : "switch on"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  )
}

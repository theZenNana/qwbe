"use client"

// THE TERMINAL — the CLI, reachable from the web through the gate.
//
// The command list is not written here. It comes from `GET /cli/commands`, which the kernel
// aggregates from every cube's manifest — core and plugin alike. A cube that declares a command
// gets a line in this list, and one that is switched off loses it, with nothing changed in this
// file.
//
// Commands the caller may not run are shown greyed rather than hidden: knowing a capability
// exists but needs a different role is more useful than a list that silently differs per person.

import { useEffect, useRef, useState } from "react"
import { type Command, commands, exec } from "../../lib/api"
import { Shell } from "../Shell"

// `id` există ca să existe o cheie stabilă în listă. Indicele nu e cheie: două comenzi care dau
// exact același text sunt două intrări diferite în istoric, iar React le-ar putea confunda la
// randare. Un contor care doar crește nu se poate repeta, spre deosebire de textul rulat.
type Line = { id: number; kind: "in" | "out" | "err"; text: string }

export default function Terminal() {
  const [known, setKnown] = useState<Array<Command>>([])
  const [line, setLine] = useState("cli:help")
  const [history, setHistory] = useState<Array<Line>>([])
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const nextId = useRef(0)
  const adauga = (l: Omit<Line, "id">) => setHistory((h) => [...h, { ...l, id: nextId.current++ }])

  useEffect(() => {
    commands()
      .then(setKnown)
      .catch(() => setKnown([]))
  }, [])

  // `history` nu e citit aici, e declanșatorul. Efectul derulează la fund DUPĂ ce s-a randat o
  // linie nouă; fără dependența asta ar rula o singură dată, la montare, iar terminalul ar
  // rămâne blocat sus în timp ce ieșirea curge sub margine.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependența e declanșatorul, nu o citire
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [history])

  const run = async (text: string) => {
    if (!text.trim()) return
    setBusy(true)
    adauga({ kind: "in", text })
    try {
      const r = await exec(text)
      adauga({ kind: r.ok ? "out" : "err", text: r.output })
    } catch (e) {
      adauga({ kind: "err", text: (e as Error).message })
    } finally {
      setBusy(false)
      // Refresh the list: a command may have changed which cubes are on.
      commands()
        .then(setKnown)
        .catch(() => undefined)
    }
  }

  return (
    <Shell>
      <h2>terminal</h2>
      <p className="subtitlu">
        Runs through <code>POST /cli/exec</code>. Only declared commands run — there is no shell behind this, and each
        command is checked against your own permissions.
      </p>

      <div className="panou">
        <div
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 13,
            // Terminalul rămâne întunecat dinadins — asta arată un terminal. Dar de aici
            // încolo NU se mai folosesc tokenii temei: ei sunt acum ai temei deschise, iar
            // `var(--text)` pe fundalul ăsta ar fi text închis pe închis. Culorile de aici
            // sunt scrise explicit, fiindcă suprafața asta nu urmează pagina.
            background: "#0c0f14",
            color: "#e6e9ef",
            border: "1px solid #262b36",
            borderRadius: 6,
            padding: 12,
            minHeight: 220,
            maxHeight: 380,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
          }}
          data-testid="terminal-output"
        >
          {history.length === 0 && <div className="mic">Try `cli:help`.</div>}
          {history.map((l) => (
            <div
              key={l.id}
              style={{
                color: l.kind === "in" ? "#6ea8fe" : l.kind === "err" ? "#ffb4b4" : "#e6e9ef",
                marginBottom: 4,
              }}
            >
              {l.kind === "in" ? `$ ${l.text}` : l.text}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <form
          style={{ display: "flex", gap: 8, marginTop: 10 }}
          onSubmit={async (e) => {
            e.preventDefault()
            const text = line
            setLine("")
            await run(text)
          }}
        >
          <input
            style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="cube:command [args]"
            data-testid="terminal-input"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            run
          </button>
        </form>
      </div>

      <div className="panou">
        <h3>Commands ({known.length}) — declared by the cubes, not by this page</h3>
        <table>
          <tbody>
            {known.map((c) => (
              <tr key={c.name} style={c.allowed ? undefined : { opacity: 0.45 }}>
                <td style={{ width: 200 }}>
                  {/* Buton, nu legătură: nu navighează nicăieri, doar scrie numele în câmpul
                      de comandă. `href="#"` anulat de `preventDefault` e un buton deghizat. */}
                  <button type="button" className="ca-link" onClick={() => setLine(c.name)}>
                    {c.name}
                  </button>
                </td>
                <td className="mic">{c.summary}</td>
                <td className="mic">{c.allowed ? c.permission : `needs ${c.permission}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  )
}

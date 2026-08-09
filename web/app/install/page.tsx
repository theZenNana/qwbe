"use client"

// INSTALL — what is mounted, what can be installed, and what an operation actually changed.
//
// The screen answers a question the rest of the app leaves open: "installing a cube is copying a
// directory" is true in the kernel, but nobody could see it. Here the effect is shown — and,
// more importantly, shown HONESTLY.
//
// The one place a page like this is tempted to lie is the moment after an install. The
// directory is on disk, so it feels done; it is not. The kernel discovers cubes at STARTUP, so
// nothing is mounted until the API restarts, and the API says so in the response
// (`requiresRestart: true`). So instead of listing the new routes as though they were live, this
// page MEASURES: it takes a snapshot of what the server exposes before the operation and after
// it, and prints the difference. After an install that difference is empty — and the page says
// that in as many words, next to the restart banner. An empty diff is the proof, not a bug.
//
// Nothing here is written per cube. Every name on screen arrives from the API: the catalogue,
// the store listing, the command list, the permissions of the signed-in user, and the OpenAPI
// document. Grep this file for the name of any cube in the system and you will not find one.

import { useCallback, useEffect, useState } from "react"
import {
  ApiError,
  type Command,
  type CubeInfo,
  catalogue,
  commands,
  installPackage,
  me,
  type PackageInfo,
  packages,
  removeCube,
  restartApi,
  routes,
  toggleCube,
  uninstallPackage,
} from "../../lib/api"
import { Shell } from "../Shell"

/** What the server exposed at one instant. Diffed against the next one to get a real effect. */
type Snapshot = {
  cubes: Array<string>
  commands: Array<string>
  permissions: Array<string>
  events: Array<string>
  routes: Array<string>
}

type Diff = { added: Array<string>; gone: Array<string> }

const diff = (before: Array<string>, after: Array<string>): Diff => ({
  added: after.filter((x) => !before.includes(x)),
  gone: before.filter((x) => !after.includes(x)),
})

type Effect = {
  title: string
  explanation: string
  /** Present only for install/remove — the operations that write to disk. */
  requiresRestart: boolean
  lists: Array<{ label: string; note?: string; diff: Diff }>
}

// `id`, fiindcă jurnalul se scrie la CAP: indicele fiecărui rând se schimbă la orice operație.
type LogLine = { id: number; time: string; text: string; bad?: boolean }
let idJurnal = 0

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

const clock = () => new Date().toLocaleTimeString("ro-RO", { hour12: false })

/**
 * The commands a cube contributes.
 *
 * Not a guess and not a convention this file invented: the kernel refuses to mount a cube whose
 * command or permission names do not start with `<cube>:` (`validateManifest` in the manifest
 * kernel), precisely so that a cube cannot grant itself another's. That makes the prefix a fact
 * about the data, safe to read back out of it.
 */
const owned = (names: Array<string>, cube: string) => names.filter((n) => n.startsWith(`${cube}:`))

/** "1 comandă", "3 comenzi" — a count with a number in front of it reads as noise otherwise. */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export default function Install() {
  const [cubes, setCubes] = useState<Array<CubeInfo> | null>(null)
  const [store, setStore] = useState<Array<PackageInfo> | null>(null)
  const [cmds, setCmds] = useState<Array<Command>>([])
  const [perms, setPerms] = useState<Array<string>>([])
  const [rts, setRts] = useState<Array<string>>([])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  const [effect, setEffect] = useState<Effect | null>(null)
  const [log, setLog] = useState<Array<LogLine>>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Cubes deleted from disk in this session that the running server still has mounted. */
  const [deleted, setDeleted] = useState<Array<string>>([])

  const write = (lines: Array<string>, bad = false) => {
    const time = clock()
    setLog((old) => [...lines.map((text) => ({ id: idJurnal++, time, text, bad })), ...old].slice(0, 200))
  }

  /** One read of everything the page shows. Returns the snapshot so an operation can diff it. */
  const read = useCallback(async (): Promise<Snapshot> => {
    const [c, p, k, u, r] = await Promise.all([catalogue(), packages(), commands(), me(), routes()])
    setCubes(c)
    setStore(p)
    setCmds(k)
    setPerms([...u.permissions])
    setRts(r)
    const live = c.filter((x) => x.enabled)
    const snap: Snapshot = {
      cubes: live.map((x) => x.name),
      commands: k.map((x) => x.name),
      permissions: [...u.permissions].sort(),
      events: live.flatMap((x) => x.publishes).sort(),
      routes: r,
    }
    setSnapshot(snap)
    return snap
  }, [])

  useEffect(() => {
    read().catch((e: Error) => setError(e.message))
  }, [read])

  /** Run one operation, then measure. The effect panel is the difference, never a prediction. */
  const run = async (
    key: string,
    call: () => Promise<{ title: string; explanation: string; requiresRestart: boolean; log: Array<string> }>,
  ) => {
    setBusy(key)
    setError(null)
    const before = snapshot
    try {
      const outcome = await call()
      const after = await read()
      setEffect({
        title: outcome.title,
        explanation: outcome.explanation,
        requiresRestart: outcome.requiresRestart,
        lists: before
          ? [
              { label: "Cuburi montate", diff: diff(before.cubes, after.cubes) },
              { label: "Comenzi în terminal", diff: diff(before.commands, after.commands) },
              { label: "Evenimente pe bus", diff: diff(before.events, after.events) },
              {
                label: "Permisiuni (ale mele)",
                note: "adunate din manifeste la pornire — stinsul unui cub nu le mișcă",
                diff: diff(before.permissions, after.permissions),
              },
              {
                label: "Rute declarate",
                note: "din /openapi.json, compus la pornire — un cub stins rămâne în listă și răspunde 404",
                diff: diff(before.routes, after.routes),
              },
            ]
          : [],
      })
      write(outcome.log)
    } catch (e) {
      const status = e instanceof ApiError ? `HTTP ${e.status}` : "eroare"
      // The installer's refusals say exactly what was refused and why. Passing the text through
      // is the whole point — "a apărut o eroare" would throw away the only useful part.
      setError(`${status} — ${(e as Error).message}`)
      write([`${key} — refuzat (${status}): ${(e as Error).message}`], true)
    } finally {
      setBusy(null)
    }
  }

  const mounted = new Set((cubes ?? []).map((c) => c.name))
  const onDiskNotMounted = (store ?? []).filter((p) => p.installed && p.cubes.some((c) => !mounted.has(c)))
  const mountedNotOnDisk = [
    ...new Set([
      ...(store ?? []).filter((p) => !p.installed).flatMap((p) => p.cubes.filter((c) => mounted.has(c))),
      ...deleted.filter((c) => mounted.has(c)),
    ]),
  ]
  const pendingRestart = onDiskNotMounted.length > 0 || mountedNotOnDisk.length > 0

  return (
    <Shell>
      <div className="inst-cap">
        <div>
          <h2>Instalare</h2>
          <p className="subtitlu">
            Un cub e un director. Instalarea îl copiază, scoaterea îl șterge — niciun fișier existent nu e editat,
            fiindcă nu există nicio listă centrală de ținut la zi.
          </p>
        </div>
        <div className="inst-contoare">
          <span>
            cuburi montate <b>{cubes?.length ?? 0}</b>
          </span>
          <span>
            pornite <b>{(cubes ?? []).filter((c) => c.enabled).length}</b>
          </span>
          <span>
            rute <b>{rts.length}</b>
          </span>
          <span>
            permisiuni <b>{perms.length}</b>
          </span>
          <span>
            comenzi <b>{cmds.length}</b>
          </span>
        </div>
      </div>

      {error && <div className="eroare inst-eroare">{error}</div>}

      {pendingRestart && (
        <div className="inst-repornire">
          <span className="inst-semn">⟳</span>
          <div>
            <b>Discul și serverul care rulează nu mai spun același lucru — cere repornirea API-ului.</b>
            <div className="mic">
              Kernelul descoperă cuburile la pornire. Ce s-a scris pe disc între timp e acolo, dar nu e montat, deci nu
              are rute, comenzi sau evenimente încă.
            </div>
            {onDiskNotMounted.length > 0 && (
              <div className="inst-linie-repornire">
                pe disc, nemontat:{" "}
                {onDiskNotMounted.map((p) => (
                  <span key={p.name} className="mono nou" data-nemontat={p.name}>
                    {p.cubes.filter((c) => !mounted.has(c)).join(", ")}{" "}
                  </span>
                ))}
              </div>
            )}
            {mountedNotOnDisk.length > 0 && (
              <div className="inst-linie-repornire">
                șters de pe disc, încă montat:{" "}
                <span className="mono dus" data-inca-montat={mountedNotOnDisk.join(",")}>
                  {mountedNotOnDisk.join(", ")}
                </span>
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy("repornește API")
                  setError(null)
                  write(["POST /settings/restart"])
                  try {
                    await restartApi()
                    write(["restarting: true — serverul moare și systemd îl aduce înapoi"])
                  } catch {
                    // The server often dies before the response lands — that IS the success
                    // case here. The proof is what comes back up, not the status of this call.
                    write(["conexiunea a căzut — normal: serverul repornește acum"])
                  }
                  // Wait for the API to come back, then reload everything — the banner must
                  // disappear on its own, not by hoping.
                  for (let i = 0; i < 20; i++) {
                    await new Promise((res) => setTimeout(res, 1000))
                    try {
                      await catalogue()
                      break
                    } catch {
                      /* still down */
                    }
                  }
                  await read().catch(() => {})
                  setDeleted([]) // whatever the old process had mounted is settled now
                  setBusy(null)
                }}
              >
                {busy === "repornește API" ? "se repornește…" : "repornește API-ul"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="inst-grila">
        {/* ---------------------------------------------------------------- montate */}
        <section>
          <h3>Instalate</h3>
          <p className="inst-ajutor">
            Ce a găsit kernelul pe disc la pornire. Stins ≠ scos: stinsul lasă codul acolo, scoaterea șterge directorul.
          </p>

          {cubes === null && <div className="gol">se citește…</div>}
          {cubes?.length === 0 && <div className="gol">niciun cub montat</div>}

          {(cubes ?? []).map((c) => (
            <div className="inst-card" key={c.name} data-cub={c.name}>
              <div className="inst-cap-card">
                <span className="inst-nume">{c.name}</span>
                <span className={`inst-sursa ${c.plugin ? "plugin" : ""}`}>
                  {c.plugin ? `plugin: ${c.plugin}` : "nucleu"}
                </span>
                <span className={`pastila ${c.enabled ? "viu" : "stins"}`}>{c.enabled ? "pornit" : "stins"}</span>
                {c.required && <span className="pastila cerut">cerut</span>}
                {mountedNotOnDisk.includes(c.name) && <span className="pastila cerut">fără director</span>}
              </div>

              <div className="inst-detaliu">
                {c.entity ? (
                  <>
                    ține entitatea <b>{c.entity}</b>
                  </>
                ) : (
                  "fără entitate — infrastructură"
                )}
              </div>
              <div className="inst-detaliu mono inst-numere">
                {count(
                  owned(
                    cmds.map((k) => k.name),
                    c.name,
                  ).length,
                  "comandă",
                  "comenzi",
                )}{" "}
                · {count(c.publishes.length, "eveniment", "evenimente")} ·{" "}
                {count(c.links.length, "legătură", "legături")} ·{" "}
                {count(owned(perms, c.name).length, "permisiune", "permisiuni")}
              </div>

              <div className="inst-actiuni">
                <button
                  type="button"
                  data-comuta={c.name}
                  disabled={c.required || busy !== null}
                  title={c.required ? "cub cerut de sistem — nu se poate stinge" : ""}
                  onClick={() =>
                    run(c.name, async () => {
                      const r = await toggleCube(c.name, !c.enabled)
                      return {
                        title: `${c.name} — ${r.enabled ? "pornit" : "stins"}`,
                        explanation: r.enabled
                          ? "Comutator, nu instalare: codul era deja pe disc și e montat din nou, fără repornire."
                          : "Stins la runtime: rutele lui răspund 404 și comenzile ies din terminal. Codul rămâne pe disc.",
                        requiresRestart: false,
                        log: [
                          `POST /settings/cubes/${c.name} {enabled:${!c.enabled}} → 200`,
                          `${c.name} e acum ${r.enabled ? "pornit" : "stins"} — fără repornire`,
                        ],
                      }
                    })
                  }
                >
                  {c.enabled ? "stinge" : "aprinde"}
                </button>

                <button
                  type="button"
                  className="inst-pericol"
                  data-scoate={c.name}
                  disabled={c.required || busy !== null}
                  title={c.required ? "cub cerut de sistem — nu se poate scoate" : ""}
                  onClick={() =>
                    run(c.name, async () => {
                      const r = await removeCube(c.name)
                      setDeleted((old) => [...new Set([...old, c.name])])
                      return {
                        title: `Scos de pe disc: ${c.name}`,
                        explanation:
                          "Directorul a fost șters. Serverul care rulează îl are însă montat din pornire, " +
                          "deci rutele lui răspund în continuare până la repornire.",
                        requiresRestart: r.requiresRestart,
                        log: [
                          `DELETE /settings/cubes/${c.name} → 200`,
                          `șters de pe disc: ${r.removed}`,
                          `requiresRestart: ${r.requiresRestart} — încă montat în procesul care rulează`,
                        ],
                      }
                    })
                  }
                >
                  scoate
                </button>
              </div>
            </div>
          ))}
        </section>

        {/* ---------------------------------------------------------------- magazin */}
        <section>
          <h3>De instalat</h3>
          <p className="inst-ajutor">
            Ce oferă magazinul. Un pachet e un cub, sau un plugin care aduce mai multe — toate intră în același spațiu
            de nume plat.
          </p>

          {store === null && <div className="gol">se citește…</div>}
          {store?.length === 0 && (
            <div className="gol">
              Magazinul e gol. Nimic de instalat — pagina rămâne întreagă, coloana asta e doar goală.
            </div>
          )}

          {(store ?? []).map((p) => {
            const missing = p.cubes.filter((c) => !mounted.has(c))
            return (
              <div className="inst-card" key={p.name} data-pachet={p.name}>
                <div className="inst-cap-card">
                  <span className="inst-nume">{p.name}</span>
                  <span className={`inst-sursa ${p.kind === "plugin" ? "plugin" : ""}`}>{p.kind}</span>
                  <span className="inst-sursa">{kb(p.bytes)}</span>
                </div>

                <div className="inst-detaliu">{p.summary || <span className="mic">fără descriere</span>}</div>
                <div className="inst-detaliu">
                  aduce: <b className="mono">{p.cubes.join(", ")}</b>
                </div>

                <div className="inst-actiuni">
                  {p.installed ? (
                    missing.length > 0 ? (
                      <>
                        <span className="inst-asteapta" data-asteapta={p.name}>
                          pe disc — cere repornire ca să fie montat
                        </span>
                        {/* Before the restart, the cube-based remove button cannot reach this:
                            it takes a MOUNTED cube, and nothing here is mounted yet. Without
                            this button, an accidental install could only be undone by first
                            restarting to mount the very thing you wanted gone. */}
                        <button
                          type="button"
                          className="inst-pericol"
                          data-dezinstaleaza={p.name}
                          disabled={busy !== null}
                          onClick={() =>
                            run(p.name, async () => {
                              const r = await uninstallPackage(p.name)
                              return {
                                title: `Instalare anulată: ${p.name}`,
                                explanation:
                                  `Directorul a fost șters de pe disc, înainte să apuce să fie montat. ` +
                                  `Serverul care rulează nu s-a atins — el nu știa de el oricum.`,
                                requiresRestart: r.requiresRestart,
                                log: [`DELETE /settings/packages/${p.name} → 200`, `șters de pe disc: ${r.removed}`],
                              }
                            })
                          }
                        >
                          anulează
                        </button>
                      </>
                    ) : (
                      <span className="inst-gata" data-instalat={p.name}>
                        instalat și montat
                      </span>
                    )
                  ) : (
                    <button
                      type="button"
                      className="inst-primar"
                      data-instaleaza={p.name}
                      disabled={busy !== null}
                      onClick={() =>
                        run(p.name, async () => {
                          const r = await installPackage(p.name)
                          return {
                            title: `${r.package.kind === "plugin" ? "Plugin" : "Cub"} instalat: ${r.package.name}`,
                            explanation:
                              `Un director a fost copiat pe disc. Nimic altceva nu s-a atins — și nimic ` +
                              `nu s-a montat: kernelul citește discul la pornire, deci ce aduce pachetul ` +
                              `(${r.package.cubes.join(", ")}) apare abia după repornirea API-ului.`,
                            requiresRestart: r.requiresRestart,
                            log: [
                              `POST /settings/packages/${p.name}/install → 200`,
                              `copiat ${kb(r.package.bytes)} — aduce: ${r.package.cubes.join(", ")}`,
                              `requiresRestart: ${r.requiresRestart} — nemontat până la repornire`,
                            ],
                          }
                        })
                      }
                    >
                      instalează
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </section>

        {/* ---------------------------------------------------------------- efect */}
        <section>
          <h3>Ce s-a schimbat</h3>
          <p className="inst-ajutor">
            Măsurat, nu prezis: un instantaneu al serverului înainte de operație și unul după, scăzute.
          </p>

          {!effect && (
            <div className="inst-card">
              <div className="gol">Încă nimic. Stinge, instalează sau scoate ceva și aici apare diferența exactă.</div>
            </div>
          )}

          {effect && (
            <>
              <div className="inst-card">
                <div className="inst-nume">{effect.title}</div>
                <div className="inst-detaliu">{effect.explanation}</div>
              </div>

              {effect.requiresRestart && (
                <div className="inst-amprenta rea" data-cere-repornire="da">
                  <span className="inst-semn">⟳</span>
                  <div>
                    <b>Cere repornire ca să fie montat.</b>
                    <div className="mic">
                      Serverul a răspuns <code className="mono">requiresRestart: true</code>. De asta listele de mai jos
                      sunt goale: pe disc s-a schimbat ceva, în procesul care rulează nu s-a schimbat nimic. Aia e
                      realitatea, nu o eroare a paginii.
                    </div>
                  </div>
                </div>
              )}

              {effect.lists.map((l) => (
                <div className="inst-card" key={l.label}>
                  <h4>
                    {l.label}{" "}
                    <span className="mono mic">
                      (+{l.diff.added.length} / −{l.diff.gone.length})
                    </span>
                  </h4>
                  {l.note && <div className="mic inst-nota">{l.note}</div>}
                  {l.diff.added.length === 0 && l.diff.gone.length === 0 ? (
                    <div className="gol inst-neschimbat">neschimbat</div>
                  ) : (
                    <ul className="inst-lista">
                      {l.diff.added.map((x) => (
                        <li key={`+${x}`} className="mono nou">
                          + {x}
                        </li>
                      ))}
                      {l.diff.gone.map((x) => (
                        <li key={`-${x}`} className="mono dus">
                          − {x}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </>
          )}
        </section>
      </div>

      {/* ---------------------------------------------------------------- jurnal */}
      <div className="inst-jurnal">
        <h3>Jurnal</h3>
        {log.length === 0 ? (
          <div className="gol">nimic încă — stinge, instalează sau scoate un cub</div>
        ) : (
          log.map((r) => (
            <div className={`inst-rand ${r.bad ? "rau" : ""}`} key={r.id}>
              <span className="inst-ora mono">{r.time}</span>
              <span className="mono">{r.text}</span>
            </div>
          ))
        )}
      </div>
    </Shell>
  )
}

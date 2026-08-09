"use client"

// THE CUSTOM FIELDS SCREEN — where an administrator adds a field to another cube.
//
// It replaces the generic list for this one cube, because a list of rows is not what a person
// wants here: they want to add a field and see, per cube, what is already there. Next.js gives
// this static segment precedence over `[cube]`, so the sidebar link needs no special case.
//
// The list of cubes you may extend comes from the catalogue — the same source the sidebar uses —
// so a cube installed five minutes ago is in the dropdown without a line changed here.

import { useCallback, useEffect, useState } from "react"
import { type CubeInfo, catalogue } from "../../lib/api"
import {
  type CustomFieldDef,
  customFieldDefs,
  defineCustomField,
  type FieldType,
  removeCustomField,
} from "../../lib/customfields-api"
import { Shell } from "../Shell"

const TYPES: Array<FieldType> = ["text", "number", "date", "bool", "select"]

export default function CustomFieldsAdmin() {
  const [cubes, setCubes] = useState<Array<CubeInfo>>([])
  const [defs, setDefs] = useState<Array<CustomFieldDef> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [targetCube, setTargetCube] = useState("")
  const [name, setName] = useState("")
  const [label, setLabel] = useState("")
  const [fieldType, setFieldType] = useState<FieldType>("text")
  const [options, setOptions] = useState("")
  const [required, setRequired] = useState(false)

  // useCallback so the effect below can name its real dependency instead of hiding it: a bare
  // function is new on every render, so `[]` would have been a lie the linter is right to call.
  const reload = useCallback(
    () =>
      customFieldDefs()
        .then((p) => setDefs(p.rows))
        .catch((e: Error) => {
          setDefs([])
          setError(e.message)
        }),
    [],
  )

  useEffect(() => {
    // Only cubes that hold rows can carry extra fields, and a cube cannot extend itself.
    catalogue()
      .then((c) => setCubes(c.filter((x) => x.entity && x.name !== "customfields")))
      .catch(() => setCubes([]))
    reload()
  }, [reload])

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      await defineCustomField({
        targetCube,
        name,
        label,
        fieldType,
        required,
        options:
          fieldType === "select"
            ? options
                .split(",")
                .map((o) => o.trim())
                .filter(Boolean)
            : [],
        // New fields go to the end of the form. Nudging one earlier is a PATCH on its position;
        // the screen for that can wait until somebody actually reorders fields.
        position: (defs ?? []).filter((d) => d.targetCube === targetCube).length + 1,
      })
      setName("")
      setLabel("")
      setOptions("")
      setRequired(false)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const drop = async (d: CustomFieldDef) => {
    setError(null)
    try {
      await removeCustomField(d.id)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const byCube = (defs ?? []).reduce<Record<string, Array<CustomFieldDef>>>((acc, d) => {
    if (!acc[d.targetCube]) acc[d.targetCube] = []
    acc[d.targetCube].push(d)
    return acc
  }, {})

  return (
    <Shell>
      <h2>customfields</h2>
      <p className="subtitlu">extra fields for any cube · the values live in this cube, next to the definitions</p>

      {error && <div className="eroare">{error}</div>}

      <div className="panou">
        <h3>Add a field</h3>
        <table>
          <tbody>
            <tr>
              <td style={{ width: 180, color: "var(--sters)" }}>cube</td>
              <td>
                <select data-testid="cf-cube" value={targetCube} onChange={(e) => setTargetCube(e.target.value)}>
                  <option value="">— pick a cube —</option>
                  {cubes.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                      {c.plugin ? ` (${c.plugin})` : ""}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
            <tr>
              <td style={{ color: "var(--sters)" }}>name</td>
              <td>
                <input
                  data-testid="cf-name"
                  value={name}
                  placeholder="cnp"
                  onChange={(e) => setName(e.target.value)}
                  style={{ width: "100%" }}
                />
                <div className="mic">
                  a letter, then letters, digits or underscores — it is the key the value is stored under
                </div>
              </td>
            </tr>
            <tr>
              <td style={{ color: "var(--sters)" }}>label</td>
              <td>
                <input
                  data-testid="cf-label"
                  value={label}
                  placeholder="CNP"
                  onChange={(e) => setLabel(e.target.value)}
                  style={{ width: "100%" }}
                />
                <div className="mic">what the form shows. Empty means the name is used.</div>
              </td>
            </tr>
            <tr>
              <td style={{ color: "var(--sters)" }}>type</td>
              <td>
                <select
                  data-testid="cf-type"
                  value={fieldType}
                  onChange={(e) => setFieldType(e.target.value as FieldType)}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
            {fieldType === "select" && (
              <tr>
                <td style={{ color: "var(--sters)" }}>options</td>
                <td>
                  <input
                    data-testid="cf-options"
                    value={options}
                    placeholder="junior, mid, senior"
                    onChange={(e) => setOptions(e.target.value)}
                    style={{ width: "100%" }}
                  />
                  <div className="mic">comma separated. A value outside this list is refused by the API.</div>
                </td>
              </tr>
            )}
            <tr>
              <td style={{ color: "var(--sters)" }}>required</td>
              <td>
                <input
                  data-testid="cf-required"
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                />
                <span className="mic"> a required field cannot be emptied once it has a value</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div className="rand-paginare">
          <button type="button" data-testid="cf-add" disabled={busy || !targetCube || !name} onClick={add}>
            {busy ? "adding…" : "add field"}
          </button>
          <span className="mic">the new field shows up on every row of that cube, at once</span>
        </div>
      </div>

      <div className="panou">
        <h3>Defined fields</h3>
        {defs === null && <div className="mic">loading…</div>}
        {defs !== null && defs.length === 0 && <div className="gol">No custom fields yet.</div>}
        {Object.entries(byCube).map(([cube, list]) => (
          <div key={cube} style={{ marginBottom: 14 }}>
            <div className="mic" style={{ marginBottom: 6 }}>
              {cube}
            </div>
            <table>
              <tbody>
                {list
                  .slice()
                  .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
                  .map((d) => (
                    <tr key={d.id}>
                      <td style={{ width: 200 }} data-field={`${d.targetCube}.${d.name}`}>
                        {d.label}
                      </td>
                      <td className="mic">
                        {d.name} · {d.fieldType}
                        {d.required ? " · required" : ""}
                        {d.options.length > 0 ? ` · [${d.options.join(" | ")}]` : ""}
                      </td>
                      <td style={{ width: 90 }}>
                        <button type="button" onClick={() => drop(d)}>
                          remove
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className="mic">
          Removing a field takes its stored values with it. Defining the same name again starts empty — an old value
          cannot come back under a new type.
        </p>
      </div>
    </Shell>
  )
}

"use client"

// THE CUSTOM FIELDS PANEL -- one component, every cube, every field type.
//
// It is the frontend half of "a separate cube that gives fields to the other cubes": nothing here
// knows what a contact or a company is. It asks `customfields` what extra fields this cube has
// and what this row holds for them, and draws an input per declared type.
//
// If the customfields cube is not installed, is switched off, or the request fails for any other
// reason, this renders NOTHING. The page it sits on keeps working with the cube's own fields --
// the same rule the rest of the app follows: the other side may simply not be there.
//
// The form does not validate. That is deliberate rather than lazy: the cube that owns the
// definitions owns the check, and it refuses a bad value with a sentence. Repeating the rules
// here would mean two places to keep in step, and the browser's copy is the one an attacker
// skips. So the message from the API is shown as it arrives.

import { useEffect, useState } from "react"
import { type FieldWithValue, rowCustomFields, setRowCustomFields } from "../lib/customfields-api"

export function CustomFields({ cube, rowId }: { cube: string; rowId: string }) {
  const [fields, setFields] = useState<Array<FieldWithValue> | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    rowCustomFields(cube, rowId)
      .then((r) => {
        setFields([...r.fields])
        setDraft(Object.fromEntries(r.fields.map((f) => [f.name, f.value])))
      })
      .catch(() => setFields(null))
  }, [cube, rowId])

  if (!fields || fields.length === 0) return null

  const dirty = fields.some((f) => (draft[f.name] ?? "") !== f.value)

  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      // Only what changed is sent. A field left alone is not re-validated, so an old value that
      // predates a stricter definition does not block an unrelated edit.
      const changed = Object.fromEntries(
        fields.filter((f) => (draft[f.name] ?? "") !== f.value).map((f) => [f.name, draft[f.name] ?? ""]),
      )
      const r = await setRowCustomFields(cube, rowId, changed)
      setFields([...r.fields])
      setDraft(Object.fromEntries(r.fields.map((f) => [f.name, f.value])))
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panou">
      <h3>Custom fields</h3>
      <p className="mic" style={{ marginTop: -6, marginBottom: 12 }}>
        declared for "{cube}" in the customfields cube * values are stored there, not in this row
      </p>

      {error && <div className="eroare">{error}</div>}
      {saved && !dirty && <div className="mic">saved.</div>}

      <table>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name}>
              <td style={{ width: 180, color: "var(--sters)" }}>
                {f.label}
                {f.required && <span style={{ color: "var(--accent)" }}> *</span>}
                <div className="mic">{f.fieldType}</div>
              </td>
              <td>
                {f.fieldType === "select" ? (
                  <select
                    data-field={f.name}
                    value={draft[f.name] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                  >
                    <option value="">--</option>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : f.fieldType === "bool" ? (
                  <select
                    data-field={f.name}
                    value={draft[f.name] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                  >
                    <option value="">--</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    data-field={f.name}
                    // `date` and `number` get the browser's own input for the type. The API checks
                    // the value regardless -- this only makes the keyboard sensible on a phone.
                    type={f.fieldType === "date" ? "date" : f.fieldType === "number" ? "number" : "text"}
                    value={draft[f.name] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                    style={{ width: "100%" }}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="rand-paginare">
        <button type="button" data-testid="save-custom" disabled={!dirty || busy} onClick={save}>
          {busy ? "saving..." : "save"}
        </button>
        <span className="mic">{dirty ? "unsaved changes" : "up to date"}</span>
      </div>
    </div>
  )
}

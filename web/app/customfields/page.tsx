"use client"

// THE CUSTOM FIELDS SCREEN -- where an administrator adds a field to another cube.
//
// It replaces the generic list for this one cube, because a list of rows is not what a person
// wants here: they want to add a field and see, per cube, what is already there. The sidebar
// link exists because the cube's manifest declares `screen: true` -- the shell renders a tab
// for it from that declaration alone, no special case here.
//
// The list of cubes you may extend comes from the catalogue -- the same source the sidebar uses --
// so a cube installed five minutes ago is in the dropdown without a line changed here.
//
// The form and the defined-fields table live in AddFieldForm.tsx and DefinedFields.tsx (file
// cap); this file keeps the state and the API calls.

import { useCallback, useEffect, useState } from "react"
import { ApiError, type CubeInfo, catalogue } from "../../lib/api"
import {
  type CustomFieldDef,
  customFieldDefs,
  defineCustomField,
  type FieldType,
  removeCustomField,
} from "../../lib/customfields-api"
import { Shell } from "../Shell"
import { AddFieldForm } from "./AddFieldForm"
import { DefinedFields } from "./DefinedFields"

export default function CustomFieldsAdmin() {
  const [cubes, setCubes] = useState<Array<CubeInfo>>([])
  const [defs, setDefs] = useState<Array<CustomFieldDef> | null>(null)
  const [total, setTotal] = useState(0)
  const [notInstalled, setNotInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

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
        .then((p) => {
          setDefs([...p.rows])
          setTotal(p.total)
          setNotInstalled(false)
        })
        .catch((e: Error) => {
          // A 404 means the customfields cube is not installed (or is switched off) -- not an
          // error to shout about, but no form either: there is nothing to add a field to.
          setNotInstalled(e instanceof ApiError && e.status === 404)
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
    setDeletingId(d.id)
    try {
      await removeCustomField(d.id)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Shell>
      <h2>customfields</h2>
      <p className="subtitlu">extra fields for any cube * the values live in this cube, next to the definitions</p>

      {notInstalled ? (
        <div className="gol">The customfields cube is not installed. Install it from Settings to add extra fields.</div>
      ) : (
        <>
          {error && <div className="eroare">{error}</div>}

          <AddFieldForm
            cubes={cubes}
            targetCube={targetCube}
            setTargetCube={setTargetCube}
            name={name}
            setName={setName}
            label={label}
            setLabel={setLabel}
            fieldType={fieldType}
            setFieldType={setFieldType}
            options={options}
            setOptions={setOptions}
            required={required}
            setRequired={setRequired}
            busy={busy}
            onAdd={add}
          />

          {/* limit=200 is the server's MAX_LIMIT; if more definitions exist than came back, say
              so instead of silently showing a subset (whose positions are then also partial). */}
          {defs !== null && total > defs.length && (
            <div className="eroare">
              showing {defs.length} of {total} definitions -- the rest are past the server's page limit
            </div>
          )}

          <DefinedFields defs={defs} deletingId={deletingId} onDrop={drop} />
        </>
      )}
    </Shell>
  )
}

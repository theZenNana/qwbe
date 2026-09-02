// Parsers for the two import formats. Pure functions: text in, records and malformed lines out.
//
// The rule that shapes this module: a malformed line does not kill the import. It is counted,
// reported with its ABSOLUTE line number in the source file (the caller passes `startLine` when
// a file arrives in several chunks), and the import continues. Nothing here throws.

export type Malformed = { readonly line: number; readonly reason: string }
export type ParsedRecord = Record<string, unknown>
export type ParseResult = {
  readonly records: ReadonlyArray<ParsedRecord>
  readonly malformed: ReadonlyArray<Malformed>
}

/**
 * JSON Lines: one JSON object per line. Blank lines are skipped, not errors.
 *
 * A line that is valid JSON but contains a NUL character (as a `\u0000` escape -- a raw NUL is
 * already invalid JSON) is reported as malformed instead of being parsed: Postgres `jsonb`
 * refuses NUL inside strings, so letting it through would kill the whole chunk transaction
 * with a 500 and no line number. Counted per line, like every other refusal.
 */
export const parseJsonl = (text: string, startLine = 1): ParseResult => {
  const records: ParsedRecord[] = []
  const malformed: Malformed[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const raw: string = lines[i] ?? ""
    const line = startLine + i
    const trimmed = raw.trim()
    if (trimmed === "") continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        malformed.push({ line, reason: "not a JSON object" })
        continue
      }
      if (JSON.stringify(value).includes("\\u0000")) {
        malformed.push({ line, reason: "contains a NUL character, not storable as jsonb" })
        continue
      }
      records.push(value as ParsedRecord)
    } catch {
      malformed.push({ line, reason: "invalid JSON" })
    }
  }
  return { records, malformed }
}

/**
 * One CSV record, RFC 4180 style: quoted fields may contain commas, doubled quotes and
 * newlines. Returns the parsed field list, the offset after the record, and the number of
 * newlines CONSUMED -- the caller tracks the absolute line number incrementally, so the cost
 * stays linear in the file length (counting from offset 0 per record made parsing quadratic
 * and blocked the event loop for seconds on a large chunk).
 */
const csvRecord = (text: string, from: number): { fields: string[]; end: number; newlines: number } => {
  const fields: string[] = []
  let field = ""
  let quoted = false
  let i = from
  let newlines = 0
  while (i < text.length) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      if (c === "\n") newlines++
      field += c
      i++
      continue
    }
    if (c === '"') {
      quoted = true
      i++
      continue
    }
    if (c === ",") {
      fields.push(field)
      field = ""
      i++
      continue
    }
    if (c === "\n") {
      newlines++
      i++
      break
    }
    if (c === "\r" && text[i + 1] === "\n") {
      newlines++
      i += 2
      break
    }
    field += c
    i++
  }
  fields.push(field)
  return { fields, end: i, newlines }
}

/** The field names of a CSV's header row -- used to store the header on the set at the first
 *  chunk so later chunks are parsed against the SAME names. */
export const csvHeaderOf = (text: string): ReadonlyArray<string> => dedupe(csvRecord(text, 0).fields)

/** Duplicate header names get a `_2`, `_3` ... suffix -- silently collapsing them lost a
 *  column with no malformed entry. */
const dedupe = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Map<string, number>()
  return names.map((raw) => {
    const base = raw.trim()
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}_${n + 1}`
  })
}

/**
 * CSV with a header row. Values stay strings -- the profile's shape detector reads content,
 * and "raw" means we do not second-guess the source file's types.
 *
 * Multi-chunk imports pass the header stored on the set (`header`): the caller then asserts
 * the text holds DATA rows only. Without it, every chunk consumes its first line as a header,
 * so chunk 2+ silently ate one data row and keyed the rest by that row's values.
 */
export const parseCsv = (text: string, startLine = 1, header?: ReadonlyArray<string>): ParseResult => {
  const records: ParsedRecord[] = []
  const malformed: Malformed[] = []
  if (text.trim() === "") return { records, malformed: [{ line: startLine, reason: "empty CSV input" }] }
  let names: ReadonlyArray<string>
  let offset: number
  let line: number
  if (header !== undefined) {
    names = header
    offset = 0
    line = startLine
  } else {
    const head = csvRecord(text, 0)
    if (head.fields.every((h) => h.trim() === "")) {
      return { records, malformed: [{ line: startLine, reason: "missing CSV header row" }] }
    }
    names = dedupe(head.fields)
    offset = head.end
    line = startLine + head.newlines
  }
  while (offset < text.length) {
    const startLine_ = line
    const rec = csvRecord(text, offset)
    line += rec.newlines
    if (rec.fields.length === 1 && (rec.fields[0] ?? "").trim() === "" && rec.end >= text.length) break
    if (rec.fields.length !== names.length) {
      malformed.push({
        line: startLine_,
        reason: `${rec.fields.length} columns, header has ${names.length}`,
      })
    } else {
      const row: ParsedRecord = {}
      names.forEach((h, i) => {
        row[h] = rec.fields[i]
      })
      records.push(row)
    }
    offset = rec.end
  }
  return { records, malformed }
}

export const parseChunk = (
  format: "jsonl" | "csv",
  text: string,
  startLine = 1,
  header?: ReadonlyArray<string>,
): ParseResult => (format === "jsonl" ? parseJsonl(text, startLine) : parseCsv(text, startLine, header))

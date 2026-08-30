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

/** JSON Lines: one JSON object per line. Blank lines are skipped, not errors. */
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
      records.push(value as ParsedRecord)
    } catch {
      malformed.push({ line, reason: "invalid JSON" })
    }
  }
  return { records, malformed }
}

/**
 * One CSV record, RFC 4180 style: quoted fields may contain commas, doubled quotes and
 * newlines. Returns the parsed field list and the line the record STARTED on -- a quoted
 * newline makes a record span lines, and the malformed report must name the line the record
 * STARTED on, not the line it happened to end on.
 */
const csvRecord = (text: string, from: number): { fields: string[]; end: number; startLine: number } => {
  const fields: string[] = []
  let field = ""
  let quoted = false
  let i = from
  let line = 1
  for (let j = 0; j < from; j++) if (text[j] === "\n") line++
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
      if (c === "\n") line++
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
      i++
      break
    }
    if (c === "\r" && text[i + 1] === "\n") {
      i += 2
      break
    }
    field += c
    i++
  }
  fields.push(field)
  return { fields, end: i, startLine: line }
}

/** CSV with a header row. Values stay strings -- the profile's shape detector reads content,
 *  and "raw" means we do not second-guess the source file's types. */
export const parseCsv = (text: string, startLine = 1): ParseResult => {
  const records: ParsedRecord[] = []
  const malformed: Malformed[] = []
  if (text.trim() === "") return { records, malformed: [{ line: startLine, reason: "empty CSV input" }] }
  const header = csvRecord(text, 0)
  if (header.fields.every((h) => h.trim() === "")) {
    return { records, malformed: [{ line: startLine, reason: "missing CSV header row" }] }
  }
  let offset = header.end
  while (offset < text.length) {
    const rec = csvRecord(text, offset)
    if (rec.fields.length === 1 && (rec.fields[0] ?? "").trim() === "" && rec.end >= text.length) break
    const line = startLine + rec.startLine - 1
    if (rec.fields.length !== header.fields.length) {
      malformed.push({
        line,
        reason: `${rec.fields.length} columns, header has ${header.fields.length}`,
      })
    } else {
      const row: ParsedRecord = {}
      header.fields.forEach((h, i) => {
        row[h.trim()] = rec.fields[i]
      })
      records.push(row)
    }
    offset = rec.end
  }
  return { records, malformed }
}

export const parseChunk = (format: "jsonl" | "csv", text: string, startLine = 1): ParseResult =>
  format === "jsonl" ? parseJsonl(text, startLine) : parseCsv(text, startLine)

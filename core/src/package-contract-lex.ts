// The lexer half of the package contract: turning source text into something a rule can judge
// without tripping on prose. Split from `package-contract-scan.ts` for the cap, not for show --
// the rules change often, the lexer almost never.

/**
 * Strip comments, and optionally string-literal contents, so a mention in prose cannot raise a
 * finding: a file whose only `writeFile` sits in a comment does not write. A lexer, not a
 * regex, for the reason `probes/size-lib.mjs` gives -- a regex over `//` eats the `//` inside
 * a URL string. String contents survive by default (module specifiers live in them and must
 * still be readable); `dropStrings` removes them for the includes-based rules, where text
 * inside quotes is never a call and never a write.
 */
export const stripCode = (source: string, dropStrings = false): string => {
  let out = ""
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (quote) {
      if (c === "\\") {
        if (!dropStrings) out += c + (source[i + 1] ?? "")
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
        out += c
      } else if (!dropStrings) out += c
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** Every module specifier the file names: `from "..."`, `import(...)`, `require(...)`, and bare
 * `import "..."`. Whole-file extraction, not a filter on the line the keyword sits on -- a
 * multi-line import or a re-export names a module just as much as a one-line import does. */
export const specifiers = (text: string): string[] => {
  const found: string[] = []
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(?\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ]) {
    for (const match of text.matchAll(pattern)) found.push(match[1] ?? "")
  }
  return found
}

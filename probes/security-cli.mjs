// Section 3: the CLI gate.
//
// The claim: only declared commands run, by map lookup, with the command's own permission checked
// per caller. No shell, no eval.
//
// The check worth reading is the one about surplus arguments. `notes:count && cat /etc/passwd`
// used to return 200 — the first token is a real command and the rest was silently discarded, so
// the caller believed the whole line had run. Silently doing less than you were asked is the
// defect this whole file is shaped around.

const SHELL_ATTEMPTS = [
  "notes:count; rm -rf /",
  "notes:count && cat /etc/passwd",
  "$(whoami)",
  "`id`",
  "notes:count | tee /tmp/pwned",
  "../../../bin/sh",
  "__proto__",
  "constructor",
]

export const theCliGate = async ({ api, score, H }) => {
  let allRefused = true
  let leaked = ""
  for (const line of SHELL_ATTEMPTS) {
    const r = await api.call("/cli/exec", { method: "POST", headers: H, body: JSON.stringify({ line }) })
    const refused = r.status === 400
    if (!refused) {
      allRefused = false
      leaked = `"${line}" returned ${r.status}: ${JSON.stringify(r.body).slice(0, 100)}`
      break
    }
  }
  score.check(
    "CLI: eight shell-shaped inputs are all refused, nothing silently discarded",
    allRefused,
    allRefused ? "every one rejected with a reason" : leaked,
  )

  const extraArgs = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "notes:count extra junk here" }),
  })
  score.check(
    "CLI: surplus arguments to a zero-argument command are refused, not ignored",
    extraArgs.status === 400 && String(extraArgs.body?.message).includes("takes 0 argument"),
    `http=${extraArgs.status}`,
  )

  const withinArity = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "notes:recent 2" }),
  })
  score.check(
    "CLI: a command that declares an argument still accepts it",
    withinArity.status === 200 && withinArity.body?.ok === true,
    `http=${withinArity.status}`,
  )

  const unknownName = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "nosuch:command" }),
  })
  score.check(
    "CLI: an unknown command no longer hands out the full catalogue",
    unknownName.status === 400 && !String(unknownName.body?.message).includes("account:"),
    `message: ${String(unknownName.body?.message).slice(0, 60)}`,
  )

  // A prototype-polluting name must not resolve to something on Object.prototype.
  const proto = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "toString" }),
  })
  score.check(
    "CLI: a name from Object.prototype does not resolve to a command",
    proto.status === 400,
    `http=${proto.status}`,
  )

  // Arguments reach only the declared function. `notes:recent` takes a count; a hostile
  // argument must not become anything else.
  await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "notes:recent 1; DROP TABLE notes" }),
  })
  const stillThere = await api.call("/notes?limit=5", { headers: H })
  score.check(
    "CLI: a hostile argument does not escape the declared function",
    stillThere.status === 200 && stillThere.body?.total === 1,
    `after the call, total=${stillThere.body?.total}`,
  )
}

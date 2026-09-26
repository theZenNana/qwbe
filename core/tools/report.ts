// Pure text for the check report. No I/O in this module.

const TAIL_LINES = 15

/** The problems of one command: none on exit 0, else the command, its status and its last lines. */
export const exitProblems = (command: string, status: number, output: string) =>
  status === 0 ? [] : [`${command} exited ${status}`, ...output.trimEnd().split("\n").slice(-TAIL_LINES)]

/** One gate: PASS or FAIL, its name and duration, then each problem indented. */
export const gateLine = (name: string, millis: number, problems: ReadonlyArray<string>) =>
  [
    `${problems.length === 0 ? "PASS" : "FAIL"} ${name} (${Math.round(millis)} ms)`,
    ...problems.map((line) => `  ${line}`),
  ].join("\n")

export const summaryLine = (red: number, total: number) => `\n${total - red}/${total} gates green`

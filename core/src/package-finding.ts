// Shared finding shape for the package contract checkers. Leaf module, so files that
// must not open the pack door (package-contract / package-contract-scan) can still name
// the result type (QWB-70).

/** One broken rule in one file. `rule` is a stable id a pack can filter on. */
export type PackageFinding = {
  readonly rule: string
  readonly file: string
  readonly message: string
}

# CLAUDE.md — qwbe (local, gitignored)

This file is not in the repo. It exists only on this machine (and wherever
someone copies it). The lab clone does not have it.

@AGENTS.md

## What is here

- `~/Projects/Qwbe/qwbe` (this repo): the platform. API on :4500, web on :4510.
- `~/Projects/Qwbe/plugins/{crm-pack,activegraph,qwbe-integrations}`: three
  separate repos, each with its own remote. Not submodules.
- The server runs on the lab machine (http://192.168.1.154:4510, see the wiki).
  Locally the code is for reading, reviewing and editing. Do not start the
  server here unless the owner asks.
- Wiki (dated notes, direction, incidents): `~/Projects/wiki/qwbe/`. Start with
  `DIRECTION.md` and the newest dated file. The wiki describes the past; the
  code and the live config decide the present.

## Git

- Work on a branch named `<type>/<slug>` (types in `scripts/check-branch.mjs`).
  Never commit on `main`; `main` receives merges from pull requests.
- The husky hooks in `.husky/` run on every commit: branch name, `.env*`
  refusal, secretlint, gitleaks, ASCII on added lines, lint-staged. Do not use
  `--no-verify`. A hook that fails is telling you something; fix the cause.
- The plugin repos have the same gitleaks check in `.githooks/pre-commit`,
  enabled per clone with `git config core.hooksPath .githooks`.
- Before any push, scan the commits that are about to leave:
  `gitleaks git . --log-opts="origin/main..HEAD" --no-banner`. Zero findings is
  the condition for pushing. The `secrets-gate` agent does this for you.
- Commit messages: ASCII, subject up to 72 characters, no trailing period, a
  blank line before the body. Not Conventional Commits; write one sentence of
  reasoning instead of a prefix.
- Never put Kaneo URLs, tokens, lab IPs or the PAT in commits, READMEs or PRs.
  Reference tickets as `QWB-<n>` only.

## Source

- English only in source, comments and messages. The pre-commit hook rejects
  non-ASCII on added lines.
- Read `AGENTS.md` for how to talk to the owner. Read the wiki file for the
  ticket you are on before touching code.

## Agents in `.claude/agents/`

- `secrets-gate` — runs gitleaks on the repos you name and reports verbatim.
  Never commits or pushes. Use before every push.
- `qwbe-locator` — read-only search across qwbe and the plugins. Use for
  "where is X" questions instead of grepping in the main thread.
- `qwbe-reviewer` — reviews a diff or branch: plugin contracts, permissions,
  ASCII and English, secrets. One line per finding.

Code is written and changed in the main session, not by these agents.

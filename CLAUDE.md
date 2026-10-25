# SDA — Budget Planner + agents

## Project

- The app lives in `budget-planner/`: a zero-dependency Node (>= 20, ESM) server
  (`server.js`, `lib/`), a PWA front end (`public/`), an Android WebView wrapper
  (`android/`) and Windows auto-start scripts (`windows/`).
- Currency is RON. Pay periods run from salary to salary (`public/js/shared/periods.js`).
- Cash-flow rule: the current account (ending 7204) counts money in as income and
  money out as expense; the credit card (ending 8391) is for analysis only
  (spending, amount owed, repayment plan); own-account transfers are not income.
- Tests: `cd budget-planner && npm test` (node:test). Run them after every code change.
- Don't commit secrets: `.env`, `*.pem`, `data/`, `.claude-flow/`, `settings.local.json`.
- No new npm dependencies without asking — the server is deliberately dependency-free.
- Keep new modules small and focused (existing large files such as `app.js` are fine to edit in place).
- On the user's laptop the server runs from the `SDA` clone (`~/SDA/budget-planner`), which must
  stay on this branch. Don't `git checkout`/`git switch` another branch in that folder — other
  branches have no `budget-planner/`, so the app vanishes. Work on other projects in a separate
  folder: `git worktree add ~/<project> <branch>` or a new clone.

## How to reply

- **Quiet mode.** No narration of what you or the agents are doing, no plans or status
  updates, no recaps. Run agents in the background. Speak only to ask for a manual step or an
  important decision (one short question). Final reply: the result only, as short as possible,
  in the user's language.
- **Usage limits.** In cloud sessions (web/phone), before long runs arm a `send_later` check-in
  that resumes the work after a usage limit, so I don't have to say "continue"; delete it once
  the work is pushed. On the laptop there is no `send_later`: if a limit stops you, leave a
  one-line note of where to resume.

## Efficient agents

Use as many subagents as the task has genuinely separate parts — the goal is that no token is
spent twice, not fewer agents. A 1–2 line fix, docs or a config tweak needs none.

- Agents in `.claude/agents/` already carry the right model: `finder` (haiku) for search;
  `researcher`, `tester`, `reviewer`, `security-auditor`, `production-validator` (sonnet);
  `planner`, `architect`, `coder` (main model). Prefer them over general-purpose agents.
- Before spawning, write one compact brief (≤ ~1 page: files with line ranges, key facts,
  constraints). Every agent prompt starts with that same brief, then its task, so the prompt
  cache is reused and no agent re-explores the repo.
- Each agent owns distinct files or a distinct question; only one agent writes to a given file
  (or works in its own worktree).
- Agents reply in ≤ ~300 words with `file:line`, confidence and what they did not check.
  Pipelines pass on that summary, not transcripts. Agents stop once answered.
- Web: search only when the answer isn't in the repo; one agent searches and shares the
  results. Snippets before full scrapes; Playwright only to click, fill or screenshot.

## Ruflo (optional — off unless I ask)

- `/ruflo <agent> <task>` runs one of the agents above; `/ruflo auto <task>` picks agents by
  complexity; `/ruflo swarm <task>` proposes agents and waits for my pick. Tiers and the
  routing table: `.claude/commands/ruflo.md`.
- The ruflo MCP server and CLI are not loaded by default: their tools and background daemon
  spend tokens without doing the work. Use them only when I ask, and stop the daemon after
  (`npx ruflo@3.53.0 daemon stop`). Setup, troubleshooting and restoring the full ruflo agent
  set: `docs/ruflo.md`.

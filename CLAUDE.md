# SDA — trading bot, stock signals + agents

## Projects on this branch

- `trading-bot/`: candle backtester and signal bot for IG, demo account first. Node >= 20.6,
  ESM, zero dependencies; entry points in `bin/`, logic in `lib/`. Runs from GitHub Actions
  (`.github/workflows/trading-bot.yml`); its state lives on the `trading-bot-data` branch.
- `stock-signals/`: event-driven stock alerts (SEC filings, insider buys, press releases) sent
  to Telegram. Alerts only — it never trades. Its state lives on the `signals-data` branch.
- Tests: `npm test` inside the folder you changed (node:test). Run them after every code change.
- Don't commit secrets: `.env`, `*.pem`, `data/`, `.claude-flow/`, `settings.local.json`.
- No new npm dependencies without asking — both projects are deliberately dependency-free.
- Keep new modules small and focused.

## Budget planner (other branch)

The budget planner lives only on branch `claude/budget-planner-bank-sync-03ykf8`. On the user's
laptop `~/SDA` must stay on that branch — don't `git checkout`/`git switch` there, or the app
disappears. Work on other branches in a separate folder (`git worktree add ~/<project> <branch>`).

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

- `/ruflo <agent|swarm> <task>` runs the agents above (`.claude/commands/ruflo.md`).
- The ruflo MCP server and CLI are not loaded by default: their tools and background daemon
  spend tokens without doing the work. Use them only when I ask, and stop the daemon after
  (`npx ruflo@3.53.0 daemon stop`). Setup, troubleshooting and restoring the full ruflo agent
  set: `docs/ruflo.md`.

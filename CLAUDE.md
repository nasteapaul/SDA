# SDA — Budget Planner + Ruflo agents

## Project

- The app lives in `budget-planner/`: a zero-dependency Node (>= 20, ESM) server
  (`server.js`, `lib/`), a PWA front end (`public/`), an Android WebView wrapper
  (`android/`) and Windows auto-start scripts (`windows/`).
- Currency is RON. Pay periods run from salary to salary (`public/js/shared/periods.js`).
- Cash-flow rule: the current account (ending 7204) counts money in as income and
  money out as expense; the credit card (ending 8391) is for analysis only
  (spending, amount owed, repayment plan); own-account transfers are not income.
- Tests: `cd budget-planner && npm test` (node:test). Run them after every code change.
- NEVER commit secrets: `.env`, `*.pem`, `data/`, `.claude-flow/`, `settings.local.json`.
- No new npm dependencies without asking — the server is deliberately dependency-free.
- On the user's laptop the server runs from the `SDA` clone (`~/SDA/budget-planner`), which must
  stay on branch `claude/budget-planner-bank-sync-03ykf8`. NEVER `git checkout`/`git switch`
  another branch in that folder — other branches have no `budget-planner/`, so the app vanishes.
  Work on other projects in a separate folder: `git worktree add ~/<project> <branch>` or a new clone.

## Rules

- Do what has been asked; nothing more, nothing less
- ALWAYS read a file before editing it
- Prefer editing existing files; don't create documentation files unless asked
- Validate input at system boundaries
- Keep new modules small and focused (existing large files such as `app.js` are fine to edit in place)

## Efficient agents — applies to every conversation and every agent

Use as many agents as the task has genuinely separate parts; the goal is that no
token is spent twice, not fewer agents.

1. **Context pack once.** Before spawning, the lead gathers the shared context a
   single time — relevant files with line ranges, key facts, constraints from this
   file — and writes it as one compact brief (≤ ~1 page). Every agent gets that
   brief instead of exploring the repo itself.
2. **Same prefix, cached.** Every agent prompt starts with the identical brief,
   then its role, then its own task — so parallel agents reuse the prompt cache.
   Pass only the agent file's role, rules and output format (skip its examples,
   `npx claude-flow` hook lines and memory/MCP sections).
3. **Disjoint scopes.** Each agent owns distinct files or a distinct question; no
   two agents read the same files or run the same searches. Name the exact paths.
4. **Right model per role.** `haiku` for finding/listing/grepping, `sonnet` for
   analysis, review, tests and web research; the main model only for design
   decisions, writing code and the final merge.
5. **Structured, short output.** Each agent returns ≤ ~300 words: findings as
   bullets with `file:line`, confidence, and what it did *not* check. No restating
   the task, no pasted file contents. Pipelines hand the next agent this summary,
   never raw transcripts.
6. **Stop when answered.** Agents stop as soon as their question is answered;
   no exhaustive sweeps "just in case", no agents re-checking other agents unless asked.
7. **Web once, share it.** Search only when the answer is not in the repo. One
   agent (or the lead) does the research and the results go into the brief; others
   don't repeat it. Snippets before full scrapes, at most 2–3 pages per question;
   Playwright only to click, fill or screenshot.
8. **No orchestration overhead.** Agents are Claude Code subagents; ruflo MCP tools
   (swarm_init, hive-mind, neural, memory, autopilot) and the ruflo daemon add
   tokens without doing work — use them only when I ask, and stop the daemon
   (`npx ruflo@3.53.0 daemon stop`). Turn the `claude-flow` server off in `/mcp`
   when ruflo isn't in use.
9. **No re-reading.** Don't re-read files already read in the conversation; read
   only the needed line ranges of large files.

## Ruflo agents — usable in any conversation (laptop, web or phone)

Agent definitions are in `.claude/agents/` and command recipes in `.claude/commands/`.
They are plain Markdown, so they work even where the ruflo MCP server or CLI
cannot run (e.g. a cloud session started from the phone):

- `/ruflo <agent> <task>` — e.g. `/ruflo planner what should be added for a
  fully accurate financial picture`. Claude reads the agent file and runs it as
  a subagent with that file as its instructions.
- `/ruflo swarm <task>` — several ruflo agents in parallel (fan-out), each with
  its own role, then one merged, prioritised report.
- Agents available: `core/planner`, `sparc/{specification,pseudocode,architecture,refinement}`,
  `swarm/{hierarchical,mesh,adaptive}-coordinator`, `testing/{production-validator,tdd-london-swarm}`,
  `consensus/*`, `browser/browser-agent`. Any role name also works as a custom agent.
- Agent files mention `npx claude-flow@v3alpha …` hooks; those are optional — skip
  them when the CLI is unavailable and do the work directly.

### Coordination

| Pattern | Flow | Use when |
|---------|------|----------|
| Pipeline | A → B → C | Sequential dependencies (feature dev) |
| Fan-out | Lead → A, B, C → Lead | Independent parallel work (research, review) |
| Supervisor | Lead ↔ workers | Ongoing coordination (complex refactor) |

- Read-only research agents may run in parallel; only one agent writes to a given file.
- Give every writing agent a non-overlapping file scope (or an isolated worktree).
- Swarm for 3+ files, new features, cross-module refactors, security or performance;
  not for 1–2 line fixes, docs or config tweaks.

| Task | Agents |
|------|--------|
| Bug fix | researcher, coder, tester |
| Feature | architect, coder, tester, reviewer |
| Refactor | architect, coder, reviewer |
| Security | security-architect, auditor |

## Ruflo MCP server / CLI (optional)

`.mcp.json` starts `npx -y ruflo@3.53.0 mcp start` (pinned version — bump it
deliberately). On native Windows, if the server fails to start, add it for your
user with the `cmd /c` wrapper instead:

```bash
claude mcp add claude-flow -s user -- cmd /c npx -y ruflo@3.53.0 mcp start
npx ruflo@3.53.0 doctor --fix
```

The first start downloads ruflo (~1 min), so `.claude/settings.json` raises
`MCP_TIMEOUT`. In cloud sessions, add `npx -y ruflo@3.53.0 --version` to the
environment's setup script so the download happens before the session starts.
If the server fails with `ERR_MODULE_NOT_FOUND`, the npx cache is half-installed:
delete `~/.npm/_npx` and start again.

Hive mind (queen + workers sharing memory and voting): with the MCP server
connected, use the `hive-mind_*` tools (`init`, `spawn`, `memory`, `consensus`,
`broadcast`, `status`, `shutdown`), or `/hive-mind` commands. Workers still do
the actual work as Claude Code agents; the hive gives them shared memory.

Most ruflo CLI commands auto-start a background `daemon` that spawns headless
Claude sessions and consumes tokens continuously. Stop it when done:
`npx ruflo@3.53.0 daemon stop`.

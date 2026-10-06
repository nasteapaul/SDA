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

## Rules

- Do what has been asked; nothing more, nothing less
- ALWAYS read a file before editing it
- Prefer editing existing files; don't create documentation files unless asked
- Validate input at system boundaries
- Keep new modules small and focused (existing large files such as `app.js` are fine to edit in place)

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

# Ruflo MCP server and CLI (optional)

Moved out of `CLAUDE.md` so it is read only when ruflo is being set up, not on every message.

## Turn the MCP server on for this project (when you want it)

The server is no longer started from `.mcp.json` in every session. Add it for this project only
(local scope: private to you, not committed), with the pinned version — bump it deliberately:

```bash
claude mcp add claude-flow -s local \
  -e npm_config_update_notifier=false -e CLAUDE_FLOW_MODE=v3 \
  -e CLAUDE_FLOW_HOOKS_ENABLED=true -e CLAUDE_FLOW_TOPOLOGY=hierarchical-mesh \
  -e CLAUDE_FLOW_MAX_AGENTS=15 -e CLAUDE_FLOW_MEMORY_BACKEND=hybrid \
  -- npx -y ruflo@3.53.0 mcp start
```

Turn it off again with `claude mcp remove claude-flow -s local` (or disable it in `/mcp`).

On native Windows, if the server fails to start, use the `cmd /c` wrapper:

```bash
claude mcp add claude-flow -s local -- cmd /c npx -y ruflo@3.53.0 mcp start
npx ruflo@3.53.0 doctor --fix
```

The first start downloads ruflo (~1 min), so `.claude/settings.json` raises `MCP_TIMEOUT`.
In cloud sessions, add `npx -y ruflo@3.53.0 --version` to the environment's setup script so the
download happens before the session starts. If the server fails with `ERR_MODULE_NOT_FOUND`, the
npx cache is half-installed: delete `~/.npm/_npx` and start again.

## Hive mind

Queen + workers sharing memory and voting: with the MCP server connected, use the `hive-mind_*`
tools (`init`, `spawn`, `memory`, `consensus`, `broadcast`, `status`, `shutdown`). Workers still
do the actual work as Claude Code agents; the hive gives them shared memory.

## Daemon

Most ruflo CLI commands auto-start a background `daemon` that spawns headless Claude sessions and
consumes tokens continuously. Stop it when done: `npx ruflo@3.53.0 daemon stop`.

## Restoring the full ruflo agent and command set

The original ruflo agents (`.claude/agents/*/`) and command recipes (`.claude/commands/*/`) were
replaced on 2026-10-25 by nine compact agents and `/ruflo`. To bring a folder back, without
switching branches:

```bash
# master's original set (17 agents, 148 commands) — also kept on branch ruflo-agents
git restore --source=b65f577 -- .claude/agents/sparc .claude/commands/hive-mind
# the budget-planner branch's full set (81 agents)
git restore --source=cebb2dc -- .claude/agents/v3
```

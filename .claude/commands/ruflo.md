---
description: Run a ruflo agent (or a swarm of them) from .claude/agents — works in any session, including the phone
argument-hint: <agent|swarm|auto> <task>
---

Run ruflo agents for this request: $ARGUMENTS

1. The first word is the agent name (e.g. `planner`, `architecture`,
   `production-validator`), `swarm` or `auto` (see "Auto mode" below). Find its file with
   `ls .claude/agents/*/` and read it. If no file matches, treat the word as a
   custom role (researcher, coder, reviewer, security-auditor, …).
2. Follow "Efficient agents" in CLAUDE.md. First build the context pack once:
   the relevant files with line ranges, key facts and constraints, ≤ ~1 page.
3. Single agent: start one subagent whose prompt is the context pack, then the
   agent file's role, rules and output format (skip examples, memory/MCP sections
   and `npx claude-flow …` hook lines), then the task and the exact paths to look at.
4. `swarm`: pick one agent per genuinely separate part of the task (routing table
   in CLAUDE.md). Give each a disjoint scope (its own files or question), the same
   context pack as prompt prefix, and the model for its role (`haiku` search,
   `sonnet` analysis/review/research). Start them all in one message as parallel,
   read-only subagents. Each replies in ≤ ~300 words: `file:line` findings,
   confidence, what it did not check. Then merge into one report, remove
   duplicates and rank by priority.
5. Agents only read and analyse unless the task explicitly asks for changes; when
   it does, one agent per file scope, then run `cd budget-planner && npm test`.
6. Reply in the user's language with the result and which agents were used.

## Auto mode — `/ruflo auto <task>`

Pick the agents and models from the task's complexity. Before starting, state the
chosen tier, agents and model of each in one line, then go on without waiting.

| Tier | When | Agents (model) |
|------|------|----------------|
| Simple | question, lookup, 1–2 line fix, docs/config tweak | none — the lead answers; at most one `haiku` agent to find files |
| Medium | bug fix or small feature in 1–2 files | pipeline: researcher (`haiku`) → lead writes the code → tester (`sonnet`) |
| Complex | new feature, 3+ files, cross-module refactor, security or performance | architect (main model) → coders, one per disjoint file scope (main model) → reviewer + tester in parallel (`sonnet`); security tasks add an auditor (`sonnet`) |

- Use the agents from the routing table in CLAUDE.md for the task type; pick
  the agent files from `.claude/agents/` when a role matches.
- When unsure between two tiers, take the lower one and move up only if the
  work turns out larger.
- Analysis-only tasks (no changes asked) use the same tiers but skip coders and
  tester; agents stay read-only.
- The user can force a tier or model: `/ruflo auto complex …`, `/ruflo auto sonnet …`.

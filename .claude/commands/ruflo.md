---
description: Run a ruflo agent (or a swarm of them) from .claude/agents — works in any session, including the phone
argument-hint: <agent|swarm> <task>
---

Run ruflo agents for this request: $ARGUMENTS

1. The first word is the agent name (e.g. `planner`, `architecture`,
   `production-validator`) or `swarm`. Find its file with
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

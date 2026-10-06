---
description: Run a ruflo agent (or a swarm of them) from .claude/agents — works in any session, including the phone
argument-hint: <agent|swarm> <task>
---

Run ruflo agents for this request: $ARGUMENTS

1. The first word is the agent name (e.g. `planner`, `architecture`,
   `production-validator`) or `swarm`. Find its file with
   `ls .claude/agents/*/` and read it. If no file matches, treat the word as a
   custom role (researcher, coder, reviewer, security-auditor, …).
2. Single agent: start one subagent whose prompt is the agent file's body (its
   role, principles and output format) followed by the task and the project
   context from CLAUDE.md. Skip the `npx claude-flow …` hook lines if the CLI is
   not available — they are optional.
3. `swarm`: pick 3–5 agents that fit the task (routing table in CLAUDE.md), start
   them all in one message as parallel, read-only subagents, each with its own
   agent file and a distinct angle. Then merge their findings into one report,
   remove duplicates and rank by priority.
4. Agents only read and analyse unless the task explicitly asks for changes; when
   it does, one agent per file scope, then run `cd budget-planner && npm test`.
5. Reply in the user's language with the result and which agents were used.

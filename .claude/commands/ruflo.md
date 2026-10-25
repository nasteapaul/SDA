---
description: Run one agent from .claude/agents, or a swarm of them, on a task — works in any session, including the phone
argument-hint: <agent|swarm> <task>
---

Run agents for this request: $ARGUMENTS

1. The first word is an agent name from `.claude/agents/` (`finder`, `researcher`, `planner`,
   `architect`, `coder`, `tester`, `reviewer`, `security-auditor`, `production-validator`) or
   `swarm`. A name with no file is run as a general-purpose agent with that role.
2. Follow "Efficient agents" in CLAUDE.md: build the shared brief once (relevant files with
   line ranges, key facts, constraints, ≤ ~1 page).
3. Single agent: start it with the brief, then the task and the exact paths to look at.
4. `swarm`: pick one agent per genuinely separate part of the task (routing table below).
   Give each a disjoint scope (its own files or question) and the same brief as prompt prefix.
   Start the read-only ones together in one message, in parallel. Merge their replies into one
   report, remove duplicates and rank by priority.
5. Agents only read and analyse unless the task explicitly asks for changes; when it does, one
   agent per file scope, then run `npm test` in each folder that changed.
6. Reply in the user's language with the result and which agents were used.

## Routing table (used only by `/ruflo swarm`)

| Pattern | Flow | Use when |
|---------|------|----------|
| Pipeline | A → B → C | Sequential dependencies (feature dev) |
| Fan-out | Lead → A, B, C → Lead | Independent parallel work (research, review) |
| Supervisor | Lead ↔ workers | Ongoing coordination (complex refactor) |

| Task | Agents |
|------|--------|
| Bug fix | finder or researcher, coder, tester |
| Feature | architect, coder, tester, reviewer |
| Refactor | architect, coder, reviewer |
| Security | security-auditor |
| Before going live | reviewer, production-validator |

Skip a role when the task has no separate part for it.

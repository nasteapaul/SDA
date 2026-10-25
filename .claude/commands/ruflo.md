---
description: Run one agent from .claude/agents, a swarm of them, or let auto pick — works in any session, including the phone
argument-hint: <agent|swarm|auto> <task>
---

Run agents for this request: $ARGUMENTS

1. The first word is an agent name from `.claude/agents/` (`finder`, `researcher`, `planner`,
   `architect`, `coder`, `tester`, `reviewer`, `security-auditor`, `production-validator`),
   `swarm` or `auto` (see "Auto mode" below). A name with no file is run as a general-purpose
   agent with that role.
2. Follow "Efficient agents" in CLAUDE.md: build the shared brief once (relevant files with
   line ranges, key facts, constraints, ≤ ~1 page).
3. Single agent: start it with the brief, then the task and the exact paths to look at.
4. `swarm`: first show the user a short list, then stop and wait for their choice:
   - **Top candidates** — the agents best suited to the task (routing table below), one per
     genuinely separate part, each with a few words on why.
   - **2 complementary** — two more agents that would add a different angle (e.g. security,
     tests, going live), each with a few words on what they add.
   Keep the whole list compact: one short line per agent.
   The user replies with which to run (e.g. "top", "all", or names). Then start the chosen
   agents, each with a disjoint scope (its own files or question) and the same brief as prompt
   prefix; start the read-only ones together in one message, in parallel. Merge their replies
   into one report, remove duplicates and rank by priority.
5. Agents only read and analyse unless the task explicitly asks for changes; when it does, one
   agent per file scope, then run `cd budget-planner && npm test`.
6. Quiet mode (see CLAUDE.md): run agents in the background, no progress text; final reply in
   the user's language, result only, as short as possible.

## Auto mode — `/ruflo auto <task>`

Pick the agents from the task's complexity and start without announcing the choice. Each agent
file already sets its model.

| Tier | When | Agents |
|------|------|--------|
| Simple | question, lookup, 1–2 line fix, docs/config tweak | none — the lead answers; at most one `finder` |
| Medium | bug fix or small feature in 1–2 files | `finder` or `researcher` → the lead writes the code → `tester` |
| Complex | new feature, 3+ files, cross-module refactor, security or performance | `architect` → `coder`, one per disjoint file scope → `reviewer` + `tester` in parallel; security tasks add `security-auditor` |

- When unsure between two tiers, take the lower one and move up only if the work turns out
  larger.
- Analysis-only tasks (no changes asked) use the same tiers but skip coders and tester; agents
  stay read-only.
- The user can force a tier or a model for every agent: `/ruflo auto complex …`,
  `/ruflo auto sonnet …`.

## Routing table (used by `swarm` and `auto`)

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

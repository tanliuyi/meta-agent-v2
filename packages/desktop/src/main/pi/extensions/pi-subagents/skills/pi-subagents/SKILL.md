---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, parallel,
  scripted, compatibility-chain, async, forked-context, and coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

## Subagent Plugin Methods

`subagent` and `subagent_wait` are available through `plugin_call` as `plugin["pi-subagents"].subagent(...)` and `plugin["pi-subagents"].subagent_wait(...)`. Read `references/plugin-call-api.md` before using advanced controls. The Desktop host does not expose the legacy `subagent` or `subagent_wait` Pi tools directly; keep one writer per worktree, use stable run keys, and respect child capability ceilings and approval policies.
